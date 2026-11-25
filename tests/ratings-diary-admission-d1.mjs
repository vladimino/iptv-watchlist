// AIR-602 (card A1), review of PR #1018: the REAL Ratings Diary phase (`LetterboxdRatings.start` / `step`, `src/letterboxd-ratings.js`, the run record, the event) over the REAL Ratings D1 store and the REAL canonical writers of the
// generated Worker bundle, at the admission marker `r2` and `d1`. The Diary phase calls `LetterboxdDiaryIdentity.resolve` with no route of its own (the check's default is `ratings_diary`) and the Letterboxd Sync's env.
// Offline: a sqlite D1 stand-in with the real migrations, synthetic pages, no network, no production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {scoped,scopedReplacing} from '../scripts/bundle-scope.mjs';
import * as RatingsD1 from '../src/ratings-d1.js';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import {makeBucket,makeClock,makeNetwork,loadContext,baseEnv,diaryPage,diaryRow,QUEUE,CURSOR,SEPARATE,plain,g} from './ratings-harness.mjs';

execFileSync(process.execPath,['build.mjs'],{stdio:'ignore'});
const bundle=fs.readFileSync('dist/server/index.js','utf8');
const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-ratings-admission-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const template=path.join(root,'template.sqlite');
sqlite(template,fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const OPEN="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;"
 +"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:00.000Z');"
 +"UPDATE watchlist_authority SET mode='d1',generation=1 WHERE id=1;UPDATE ratings_domain_authority SET mode='d1', cutover='open', generation=3;";
const STAMP='2026-11-25T10:00:00.000Z';
let copies=0;
const fresh=mode=>{
 const file=path.join(root,'c-'+(copies++)+'.sqlite');fs.copyFileSync(template,file);sqlite(file,OPEN);
 if(mode==='d1')sqlite(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1;UPDATE letterboxd_admission_authority SET mode='d1',generation=2,activated_at='"+STAMP+"'");
 if(mode==='closed')sqlite(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1");
 return file;
};
const start=bundle.indexOf('const OrchestrationPolicy=(()=>{');
const begin=bundle.indexOf('const LetterboxdAdmissionD1=(()=>{');
const end=bundle.indexOf('\n})();',begin)+'\n})();'.length;
const T0=Date.parse('2026-11-25T12:00:00.000Z');
const filmPage=({lid,slug,title,year,tmdb})=>'<html><head><link rel="canonical" href="https://letterboxd.com/film/'+slug+'/"><link rel="shortlink" href="https://boxd.it/'+lid+'"><meta property="og:title" content="'+title+' ('+year+')"><script type="application/ld+json">'+JSON.stringify({name:title,releasedEvent:[{'@type':'PublicationEvent',startDate:String(year)}]})+'</script></head><body class="film" data-tmdb-type="movie" data-tmdb-id="'+tmdb+'"></body></html>';

async function world(file){
 const {clock,FakeDate,crypto}=makeClock(T0),net=makeNetwork(),bucket=makeBucket();
 const web=new Map(),movies=new Map(),base=net.fetch;
 net.fetch=async(input,init)=>{
  const url=String(input);net.fetches.push(url);
  const boxd=/^https:\/\/boxd\.it\/([A-Za-z0-9]+)$/.exec(url);
  if(boxd){const item=web.get(boxd[1]);if(!item)return new Response('',{status:404});if(item.status)return new Response('',{status:item.status});return new Response('',{status:301,headers:{location:'https://letterboxd.com/film/'+item.slug+'/'}});}
  const film=/^https:\/\/letterboxd\.com\/film\/([a-z0-9-]+)\/$/.exec(url);
  if(film){const item=[...web.values()].find(entry=>entry.slug===film[1]);return item&&item.html?new Response(item.html):new Response('',{status:404});}
  const tm=/api\.themoviedb\.org\/3\/movie\/(\d+)/.exec(url);if(tm)return movies.has(tm[1])?new Response(movies.get(tm[1])):new Response('',{status:404});
  net.fetches.pop();return base(input,init);
 };
 const ctx=loadContext({net,clock,FakeDate,crypto,extra:{RatingsD1}});
 // The published EPG is not under test and its real authority would need its own marker: an empty stand-in (the Ratings run checks `typeof PublishedEpg.currentGeneration` before it uses it).
 vm.runInContext('const PublishedEpg={};',ctx);
 // The scoped canonical chain of the generated bundle, block by block (the slice also holds raw Worker files, which this context loads itself from the same sources and which would collide).
 for(const match of bundle.slice(start,end).matchAll(/^const ([A-Za-z0-9_]+)=\(\(\)=>\{\n[\s\S]*?\n\}\)\(\);/gm)){
  if(vm.runInContext('typeof '+match[1],ctx)==='undefined')vm.runInContext(match[0],ctx);
 }
 vm.runInContext('"use strict";'+fs.readFileSync('src/domain/tmdb-tv-identity.js','utf8'),ctx);
 vm.runInContext(scoped('src/letterboxd-match.js','LetterboxdMatch')+'\n'+scopedReplacing('src/letterboxd-identity.js','LetterboxdIdentity','const normTitle=LetterboxdMatch.normTitle;\n')+'\n'+scoped('src/domain/letterboxd-rated-admission.js','LetterboxdRatedAdmission')+'\n'+scoped('src/domain/letterboxd-import-registry.js','LetterboxdImportRegistry'),ctx);
 for(const source of ['src/letterboxd-rated-candidates.js','src/letterboxd-diary-identity.js'])vm.runInContext(fs.readFileSync(source,'utf8'),ctx);
 vm.runInContext("globalThis.derivedViewIndex=async env=>RatingsD1.overlayView(env,{});globalThis.viewIndexD1Version=async env=>'d1:r'+(await RatingsD1.readRatingsAuthority(env?.DB??null,env)).generation;",ctx);
 const env=baseEnv(bucket,{...SEPARATE,TMDB_API_READ_ACCESS_TOKEN:'fixture-token',DB:d1Standin(file)});
 // the supported storage (ADR 0161) lives in the Ratings D1 store here: a version 2 removal queue and a merge-form Diary cursor
 await RatingsD1.putOwned(env,QUEUE,null,{schemaVersion:2,films:{},droppedRefs:0,migratedAt:'2026-10-31T00:00:00.000Z'});
 await RatingsD1.putOwned(env,CURSOR,null,{schemaVersion:2,coverage:{newestWatchedDate:null,oldestWatchedDate:null,reachedEnd:false},resumePage:null,writer:{runId:'ratings-storage-migrate',step:'migrate'}});
 const add=(lid,slug,tmdb,title,year)=>{web.set(lid,{slug,html:filmPage({lid,slug,title,year,tmdb})});movies.set(tmdb,JSON.stringify({id:Number(tmdb),title,original_title:title,release_date:year+'-05-01'}));};
 return {clock,net,bucket,env,add,web,R:g(ctx,'LetterboxdRatings')};
}
async function runOnce(R,env,clock){
 const started=plain(await R.start(env,{trigger:'scheduled'}));assert.equal(started.created,true,JSON.stringify(started));
 let reply;for(let i=0;i<30;i++){reply=plain(await R.step(env,{runId:started.runId}));clock.now+=1000;if(reply.nextAction!=='continue')break;}
 return reply;
}
const admissionRows=file=>rows(file,'SELECT film_id,tmdb,source_code,receipt_key FROM film_rated_admission ORDER BY film_id');
const evidence=file=>rows(file,'SELECT subject_value,route,method FROM film_identity_evidence ORDER BY seq');
const receipts=file=>rows(file,"SELECT state,operation_key FROM canonical_write_receipt WHERE operation='film_admission' ORDER BY created_at");
const page=(...rs)=>diaryPage(rs);

// ===== 1. at d1: the Ratings Diary phase admits through the coordinator with its OWN route; no R2 admissions object; the label reaches the run =====
{
 const file=fresh('d1'),w=await world(file);
 w.add('vMEO','vmeo','900001','Fixture Alpha',2023);
 w.net.diary.set(1,page(diaryRow('vMEO',7,'2026-11-15','1587643799')));
 const reply=await runOnce(w.R,w.env,w.clock);
 assert.equal(reply.state,'finished',JSON.stringify(reply));
 assert.deepEqual(admissionRows(file).map(row=>[row.source_code,row.tmdb,row.receipt_key]),[['vMEO','900001','d1']],'admitted by the coordinator at d1');
 assert.deepEqual(evidence(file).map(row=>[row.subject_value,row.route,row.method]),[['vMEO','ratings_diary','page_check']],'the Diary phase is the ratings_diary route');
 assert.deepEqual(receipts(file).map(row=>[row.state,row.operation_key]),[['applied','admission:lid:vMEO']]);
 assert.equal(w.bucket.records.has('letterboxd/admissions/verified-films.json'),false,'no R2 admissions object at d1');
 const run=(await RatingsD1.readOwned(w.env,'letterboxd/ratings/run.json')).value;
 const added=run.diary.pageChanges['1'].added[0];
 assert.deepEqual([added.id,added.title,added.tmdb],['vMEO','Fixture Alpha','900001'],'the label is on the planned film before the event is finalised');
 assert.equal(run.diary.identity.verified,1);
}

// ===== 2. at closed: the Diary phase finishes, the rating is stored, and NOTHING is fetched or admitted (the id is not-now) =====
{
 const file=fresh('closed'),w=await world(file);
 w.add('vMEO','vmeo','900001','Fixture Alpha',2023);
 w.net.diary.set(1,page(diaryRow('vMEO',7,'2026-11-15','1587643799')));
 const reply=await runOnce(w.R,w.env,w.clock);
 assert.equal(reply.state,'finished',JSON.stringify(reply));
 assert.equal(admissionRows(file).length,0);assert.equal(evidence(file).length,0);
 assert.equal(w.net.fetches.filter(url=>url.includes('boxd.it')||url.includes('themoviedb')).length,0,'no source request under closed');
 const run=(await RatingsD1.readOwned(w.env,'letterboxd/ratings/run.json')).value;
 assert.equal(run.diary.pageChanges['1'].added[0].title,null,'the rating is honest without a title');
}

// ===== 3. at r2: the delivered legacy path (R2 receipt entry, no evidence row, no keyed receipt) =====
{
 const file=fresh('r2'),w=await world(file);
 w.add('vMEO','vmeo','900001','Fixture Alpha',2023);
 w.net.diary.set(1,page(diaryRow('vMEO',7,'2026-11-15','1587643799')));
 const reply=await runOnce(w.R,w.env,w.clock);
 assert.equal(reply.state,'finished',JSON.stringify(reply));
 assert.ok(w.bucket.records.get('letterboxd/admissions/verified-films.json')?.films?.tmdb_900001,'r2: the R2 receipt entry');
 assert.equal(evidence(file).length,0);assert.ok(receipts(file).every(row=>row.operation_key===null));
}

console.log('Ratings Diary phase over the admission marker (AIR-602) passed.');
