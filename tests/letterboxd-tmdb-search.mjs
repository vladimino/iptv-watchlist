// AIR-388 B2 (ADR 0105): bounded TMDB search and selection for export films the catalog does not know. Invented films, stub TMDB; no network.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DEFAULT_MAX_REQUESTS,MAX_RPS,REVIEW_REASONS,SEARCH_BASIS,runSearches,searchUrl,selectFromSearch} from '../src/letterboxd-tmdb-search.js';
import {main,tmdbSearchFn,unmatchedFilms} from '../scripts/letterboxd-tmdb-search.mjs';
import {loadCatalogDir} from '../scripts/letterboxd-reconcile.mjs';

const hit=(id,original,date,extra={})=>({id,title:extra.title??original,original_title:original,release_date:date});

// ---- The selection rule ----
const film={code:'Aa1',name:'Invented Heist',year:1995};
const one=selectFromSearch(film,[hit(11,'Invented Heist','1995-05-01'),hit(12,'Invented Heist 2','1999-01-01')]);
assert.deepEqual(one,{decision:'inferred_new',tmdb:'11',title:'Invented Heist',year:1995,basis:SEARCH_BASIS});
// a result is chosen by original title and year only; the localized title never admits
assert.equal(selectFromSearch(film,[hit(13,'Another Original','1995-01-01',{title:'Invented Heist'})]).reason,'alias_title_only');
assert.equal(selectFromSearch(film,[hit(14,'Invented Heist','1996-01-01')]).reason,'year_drift');
assert.equal(selectFromSearch(film,[hit(14,'Invented Heist','1994-12-31')]).reason,'year_drift');
assert.equal(selectFromSearch(film,[hit(14,'Invented Heist','1998-01-01')]).reason,'no_match');
assert.equal(selectFromSearch(film,[hit(15,'Invented Heist','1995-01-01'),hit(16,'Invented Heist','1995-06-01')]).reason,'multiple_exact');
// the same id twice in one answer is one movie
assert.equal(selectFromSearch(film,[hit(15,'Invented Heist','1995-01-01'),hit(15,'Invented Heist','1995-01-01')]).decision,'inferred_new');
// a remake in another year is told apart by the year
assert.equal(selectFromSearch({code:'Rm1',name:'Remake Film',year:2009},[hit(20,'Remake Film','1990-01-01'),hit(21,'Remake Film','2009-03-03')]).tmdb,'21');
assert.equal(selectFromSearch({code:'Rm2',name:'Remake Film',year:null},[hit(21,'Remake Film','2009-03-03')]).reason,'missing_year');
assert.equal(selectFromSearch(film,[]).reason,'no_result');
assert.equal(selectFromSearch(film,undefined).reason,'no_result');
// results without a usable id or release date are ignored, never trusted
assert.equal(selectFromSearch(film,[{id:'x',original_title:'Invented Heist',release_date:'1995-01-01'},{id:17,original_title:'Invented Heist',release_date:''}]).reason,'no_result');
for(const reason of ['missing_year','no_result','no_match','year_drift','alias_title_only','multiple_exact'])assert.ok(REVIEW_REASONS.includes(reason));
assert.match(searchUrl({name:'A & B: "x"'}),/^https:\/\/api\.themoviedb\.org\/3\/search\/movie\?query=A\+%26\+B%3A\+%22x%22&include_adult=false&page=1$/);

// ---- The runner: rate, budget, stop conditions, resume ----
const clock={t:1000,sleeps:[]};
const fakeSleep=async ms=>{clock.sleeps.push(ms);clock.t+=ms;},fakeNow=()=>clock.t;
const many=n=>Array.from({length:n},(_,i)=>({code:'C'+String(i).padStart(4,'0'),name:'Film '+i,year:2000}));
const okSearch=async f=>({status:200,results:[hit(1000+Number(f.code.slice(1)),f.name,'2000-01-01')]});
{
 const out=await runSearches({films:many(5),search:okSearch,sleep:fakeSleep,now:fakeNow});
 assert.equal(out.requests,5);assert.equal(out.stopped,null);assert.equal(out.remaining,0);assert.equal(out.counts.inferred_new,5);
 // 4 requests per second at most: every wait after the first request makes the gap 250 ms
 assert.ok(clock.sleeps.length>=4&&clock.sleeps.every(ms=>ms>0&&ms<=250));
}
// budget: never more than maxRequests, the rest stays pending
{
 const out=await runSearches({films:many(10),search:okSearch,maxRequests:3,sleep:fakeSleep,now:fakeNow});
 assert.equal(out.requests,3);assert.equal(out.stopped,'budget_reached');assert.equal(out.remaining,7);
}
await assert.rejects(runSearches({films:many(1),search:okSearch,maxRequests:DEFAULT_MAX_REQUESTS+1}),/maxRequests/);
await assert.rejects(runSearches({films:many(1),search:okSearch,rps:MAX_RPS+1}),/rps/);
await assert.rejects(runSearches({films:many(1),search:okSearch,rps:0}),/rps/);
// the first 429 or 403 ends the run at once, with no retry and no further request
for(const [status,stopped] of [[429,'rate_limited'],[403,'forbidden']]){
 let calls=0;
 const out=await runSearches({films:many(10),search:async f=>{calls++;return calls===3?{status}:okSearch(f);},sleep:fakeSleep,now:fakeNow});
 assert.equal(out.stopped,stopped);assert.equal(calls,3);assert.equal(out.requests,3);assert.equal(out.remaining,7);assert.equal(out.counts.inferred_new,2);assert.equal(out.counts.blocked,1,'the film behind the 403 or 429 is recorded, not forgotten');
}
// three failures in a row end the run; a success in between resets the count; an error is recorded, not decided
{
 let n=0;const out=await runSearches({films:many(10),search:async f=>{n++;return n<=3?{status:503}:okSearch(f);},sleep:fakeSleep,now:fakeNow});
 assert.equal(out.stopped,'repeated_failure');assert.equal(n,3);assert.equal(out.counts.error,3);
 let m=0;const mixed=await runSearches({films:many(6),search:async f=>{m++;return m===2||m===4?{status:500}:okSearch(f);},sleep:fakeSleep,now:fakeNow});
 assert.equal(mixed.stopped,null);assert.equal(mixed.counts.error,2);
 const thrown=await runSearches({films:many(2),search:async()=>{throw new Error('boom');},sleep:fakeSleep,now:fakeNow});
 assert.equal(thrown.counts.error,2);
}
// resume: nothing recorded is asked again, whatever its outcome (a decision, a review, an error, a blocked attempt)
{
 const state={results:{C0000:{decision:'inferred_new',tmdb:'1',title:'x',year:2000,basis:SEARCH_BASIS},C0001:{decision:'error',reason:'http_500'},C0002:{decision:'blocked',reason:'http_429'}},requests:3};
 const asked=[];
 const out=await runSearches({films:many(5),search:async f=>{asked.push(f.code);return okSearch(f);},state,sleep:fakeSleep,now:fakeNow});
 assert.deepEqual(asked,['C0003','C0004'],'an error and a blocked attempt are not asked again');assert.equal(out.remaining,0);assert.equal(out.requests,2);assert.equal(out.totalRequests,5);
 assert.equal(out.counts.error,1);assert.equal(out.counts.blocked,1);
}
// three failures then a resume: the failed films are not requested again
{
 const state={results:{},requests:0};let n=0;const asked=[];
 const first=await runSearches({films:many(6),search:async f=>{n++;asked.push(f.code);return {status:503};},state,sleep:fakeSleep,now:fakeNow});
 assert.equal(first.stopped,'repeated_failure');assert.equal(first.requests,3);
 const second=await runSearches({films:many(6),search:async f=>{asked.push(f.code);return okSearch(f);},state,sleep:fakeSleep,now:fakeNow});
 assert.deepEqual(asked,['C0000','C0001','C0002','C0003','C0004','C0005'],'each code is requested once in total');assert.equal(second.totalRequests,6);
}
// the first 429 then a resume: that code is not requested again
{
 const state={results:{},requests:0};const asked=[];
 await runSearches({films:many(4),search:async f=>{asked.push(f.code);return f.code==='C0001'?{status:429}:okSearch(f);},state,sleep:fakeSleep,now:fakeNow});
 await runSearches({films:many(4),search:async f=>{asked.push(f.code);return okSearch(f);},state,sleep:fakeSleep,now:fakeNow});
 assert.deepEqual(asked,['C0000','C0001','C0002','C0003']);assert.equal(state.results.C0001.decision,'blocked');
}
// a 401 means the credential was not applied: the run ends at once, the film is NOT recorded (nothing was learned), the request counts, and
// the same code is asked again once the credential works
{
 const state={results:{},requests:0};const asked=[];
 const first=await runSearches({films:many(4),search:async f=>{asked.push(f.code);return f.code==='C0001'?{status:401}:okSearch(f);},state,sleep:fakeSleep,now:fakeNow});
 assert.equal(first.stopped,'unauthorized');assert.equal(first.requests,2);assert.equal(state.requests,2);assert.ok(!('C0001' in state.results),'the 401 film is not recorded');assert.ok(!('C0002' in state.results));
 const second=await runSearches({films:many(4),search:async f=>{asked.push(f.code);return okSearch(f);},state,sleep:fakeSleep,now:fakeNow});
 assert.deepEqual(asked,['C0000','C0001','C0001','C0002','C0003']);assert.equal(second.remaining,0);assert.equal(second.totalRequests,5);
}
// the budget is cumulative over resumes: it is spent once, never per invocation
{
 const state={results:{},requests:0};
 const a=await runSearches({films:many(10),search:okSearch,state,maxRequests:3,sleep:fakeSleep,now:fakeNow});
 assert.equal(a.requests,3);assert.equal(a.stopped,'budget_reached');
 const b=await runSearches({films:many(10),search:okSearch,state,maxRequests:3,sleep:fakeSleep,now:fakeNow});
 assert.equal(b.requests,0);assert.equal(b.totalRequests,3);assert.equal(b.stopped,'budget_reached','a second invocation cannot spend the budget again');
 const c=await runSearches({films:many(10),search:okSearch,state,maxRequests:5,sleep:fakeSleep,now:fakeNow});
 assert.equal(c.requests,2);assert.equal(c.totalRequests,5);
}

// ---- The tool: dry run, no credential, a stub TMDB, private output, counts only ----
const scratch=await mkdtemp(path.join(os.tmpdir(),'iptv-lb-tmdb-'));
try{
 const csv=(header,rows)=>header+'\n'+rows.map(row=>row.join(',')).join('\n')+'\n';
 const exportDir=path.join(scratch,'export'),catalogDir=path.join(scratch,'catalog'),outputDir=path.join(scratch,'out');
 await mkdir(exportDir);await mkdir(catalogDir);
 await writeFile(path.join(exportDir,'watched.csv'),csv('Date,Name,Year,Letterboxd URI',[['2024-01-01','Known Film','2001','https://boxd.it/Kk1'],['2024-01-02','Secret Unknown One','2010','https://boxd.it/Uu1'],['2024-01-03','Secret Unknown Two','2011','https://boxd.it/Uu2'],['2024-01-04','Secret Unknown Three','2012','https://boxd.it/Uu3']]));
 await writeFile(path.join(exportDir,'ratings.csv'),csv('Date,Name,Year,Letterboxd URI,Rating',[['2024-01-01','Known Film','2001','https://boxd.it/Kk1','4']]));
 await writeFile(path.join(exportDir,'watchlist.csv'),csv('Date,Name,Year,Letterboxd URI',[]));
 await writeFile(path.join(exportDir,'diary.csv'),csv('Date,Name,Year,Letterboxd URI,Rating,Watched Date',[]));
 await writeFile(path.join(catalogDir,'catalog.json'),JSON.stringify({tmdb_101:{id:'tmdb_101',tmdbId:'101',canonicalIdentity:'tmdb:101',title:'Known Film',original:'Known Film',year:2001,aliases:[]}}));
 await writeFile(path.join(catalogDir,'links.json'),'{}');
 await writeFile(path.join(catalogDir,'provenance.json'),JSON.stringify({source:'live_catalog_read',readAt:'2026-11-08T16:16:32.058Z'}));

 // loadCatalogDir refuses a directory that would pass as complete when it is not
 const bad=async(mutate,pattern)=>{const dir=path.join(scratch,'bad'+Math.random().toString(36).slice(2));await mkdir(dir);for(const name of ['catalog.json','links.json','provenance.json'])await writeFile(path.join(dir,name),await readFile(path.join(catalogDir,name)));await mutate(dir);await assert.rejects(loadCatalogDir(dir),pattern);};
 await bad(dir=>rm(path.join(dir,'catalog.json')),/no catalog\.json/);
 await bad(dir=>rm(path.join(dir,'provenance.json')),/no provenance\.json/);
 await bad(dir=>writeFile(path.join(dir,'catalog.json'),'{}'),/non-empty/);
 await bad(dir=>writeFile(path.join(dir,'provenance.json'),JSON.stringify({source:'snapshot',readAt:'x'})),/live_catalog_read/);
 await bad(dir=>writeFile(path.join(dir,'links.json'),'[]'),/links\.json must be an object/);
 const loaded=await loadCatalogDir(catalogDir);assert.equal(loaded.status,'live_catalog_read');assert.equal(loaded.baselineIdentity.catalogFilms,1);assert.deepEqual(loaded.missing,['metadata.json','watchlist.json','programme.json','view-index.json']);

 const found=await unmatchedFilms({exportDir,catalogDir});
 assert.deepEqual(found.films.map(f=>f.code),['Uu1','Uu2','Uu3']);assert.equal(found.total,4);

 const base=['--export',exportDir,'--catalog-dir',catalogDir,'--output',outputDir];
 const dry=await main([...base,'--dry-run'],{env:{}});
 assert.equal(dry.dryRun,true);assert.equal(dry.requestsWouldBeMade,3);assert.equal(dry.unmatched,3);
 assert.ok(!JSON.stringify(dry).includes('Secret'));
 // no credential: nothing is requested and nothing is written
 let calls=0;
 await assert.rejects(main(base,{env:{},fetchImpl:async()=>{calls++;}}),/TMDB_READ_TOKEN is not set/);
 assert.equal(calls,0);await assert.rejects(stat(path.join(outputDir,'tmdb-results.json')));
 // bad arguments
 await assert.rejects(main([...base,'--max-requests','1501'],{env:{}}),/--max-requests/);
 await assert.rejects(main([...base,'--rps','5'],{env:{}}),/--rps/);
 await assert.rejects(main(['--export',exportDir],{env:{}}),/required/);
 await assert.rejects(main([...base.slice(0,4),'--output','tests/private-out'],{env:{}}),/absolute|outside/);

 // a stub TMDB: one unique movie, one year drift, then a 429 that ends the run
 const seen=[];
 const stub=async(url,init)=>{
  seen.push({url:String(url),auth:init.headers.Authorization});
  const query=new URL(url).searchParams.get('query');
  if(query==='Secret Unknown One')return new Response(JSON.stringify({results:[{id:501,title:'Secret Unknown One',original_title:'Secret Unknown One',release_date:'2010-02-02',popularity:9,overview:'dropped'}]}),{status:200});
  if(query==='Secret Unknown Two')return new Response(JSON.stringify({results:[{id:502,title:'Secret Unknown Two',original_title:'Secret Unknown Two',release_date:'2012-02-02'}]}),{status:200});
  return new Response('slow down',{status:429});
 };
 const run=await main(base,{env:{TMDB_READ_TOKEN:'tok-test'},fetchImpl:stub,sleep:async()=>{},now:()=>1});
 assert.equal(run.stopped,'rate_limited');assert.equal(run.requests,3);assert.equal(run.totalRequests,3);assert.equal(run.remaining,0);assert.equal(run.counts.inferred_new,1);assert.equal(run.counts['review:year_drift'],1);assert.equal(run.counts.blocked,1);
 assert.ok(seen.every(s=>s.auth==='Bearer tok-test'&&s.url.startsWith('https://api.themoviedb.org/3/search/movie?')));
 const printed=JSON.stringify(run);for(const secret of ['Secret','Uu1','tok-test','2010'])assert.ok(!printed.includes(secret),'stdout leaks '+secret);
 const saved=JSON.parse(await readFile(path.join(outputDir,'tmdb-results.json'),'utf8'));
 assert.equal(saved.results.Uu1.tmdb,'501');assert.equal(saved.results.Uu2.reason,'year_drift');assert.deepEqual(saved.results.Uu3,{decision:'blocked',reason:'http_429'},'the film behind the 429 is recorded as blocked');
 assert.equal(saved.requests,3);assert.match(saved.binding.exportSha256,/^[0-9a-f]{64}$/);assert.equal(saved.binding.catalogReadAt,'2026-11-08T16:16:32.058Z');assert.equal(saved.binding.catalogFilms,1);
 assert.ok(!JSON.stringify(saved).includes('tok-test'),'the credential is never written');
 assert.equal(((await stat(path.join(outputDir,'tmdb-results.json'))).mode&0o777),0o600);
 // resume: nothing recorded is asked again (the 429 film included) and the cumulative count stays
 const asked=[];
 const resume=await main(base,{env:{TMDB_READ_TOKEN:'tok-test'},fetchImpl:async(url)=>{asked.push(new URL(url).searchParams.get('query'));return new Response(JSON.stringify({results:[]}),{status:200});},sleep:async()=>{},now:()=>1});
 assert.deepEqual(asked,[]);assert.equal(resume.requests,0);assert.equal(resume.totalRequests,3);assert.equal(resume.counts.blocked,1);
 const dry2=await main([...base,'--dry-run'],{env:{}});assert.equal(dry2.requestsUsed,3);assert.equal(dry2.requestsWouldBeMade,0);assert.equal(dry2.alreadyAttempted,3);
 // --auth proxy: the environment injects the Authorization header, so the tool needs no token and sends none; the default still refuses
 {
  const outProxy=path.join(scratch,'out-proxy'),proxy=['--export',exportDir,'--catalog-dir',catalogDir,'--output',outProxy,'--auth','proxy'];
  await assert.rejects(main([...proxy.slice(0,6),'--auth','nonsense'],{env:{}}),/--auth must be token or proxy/);
  // a 401 (the proxy did not apply a credential): one request, that film not recorded, stop
  const seenP=[];
  const denied=await main(proxy,{env:{},fetchImpl:async(url,init)=>{seenP.push(init.headers);return new Response('no',{status:401});},sleep:async()=>{},now:()=>1});
  assert.equal(denied.auth,'proxy');assert.equal(denied.stopped,'unauthorized');assert.equal(denied.requests,1);assert.deepEqual(denied.counts,{});
  assert.ok(seenP.every(h=>h.Authorization===undefined&&h.Accept==='application/json'),'no Authorization header is sent in proxy mode');
  const savedP=JSON.parse(await readFile(path.join(outProxy,'tmdb-results.json'),'utf8'));assert.deepEqual(savedP.results,{});assert.equal(savedP.requests,1);
  // the proxy works: all three are asked (the first again), still with no header and no token
  const askedP=[],headersP=[];
  const okP=await main(proxy,{env:{},fetchImpl:async(url,init)=>{askedP.push(new URL(url).searchParams.get('query'));headersP.push(init.headers);return new Response(JSON.stringify({results:[]}),{status:200});},sleep:async()=>{},now:()=>1});
  assert.equal(askedP.length,3);assert.equal(okP.stopped,null);assert.equal(okP.totalRequests,4);assert.ok(headersP.every(h=>h.Authorization===undefined));
  assert.equal(JSON.stringify(okP).includes('tok'),false);
  // the default mode still sends the bearer header
  const tokenSeen=[];
  await main(['--export',exportDir,'--catalog-dir',catalogDir,'--output',path.join(scratch,'out-token')],{env:{TMDB_READ_TOKEN:'tok-x'},fetchImpl:async(url,init)=>{tokenSeen.push(init.headers.Authorization);return new Response(JSON.stringify({results:[]}),{status:200});},sleep:async()=>{},now:()=>1});
  assert.ok(tokenSeen.length>0&&tokenSeen.every(h=>h==='Bearer tok-x'));
 }
 // the file is bound to its export: another export (or catalog read) is refused, never reused
 await writeFile(path.join(exportDir,'watched.csv'),csv('Date,Name,Year,Letterboxd URI',[['2024-01-01','Another Film','2001','https://boxd.it/Zz9']]));
 await assert.rejects(main(base,{env:{TMDB_READ_TOKEN:'tok-test'},fetchImpl:async()=>{asked.push('x');},sleep:async()=>{},now:()=>1}),/belongs to another export or catalog read/);
 assert.deepEqual(asked,[],'a refused file makes no request');
 // tmdbSearchFn reduces an answer to the four fields the rule reads
 const reduced=await tmdbSearchFn({token:'t',fetchImpl:async()=>new Response(JSON.stringify({results:[{id:1,title:'a',original_title:'b',release_date:'2000-01-01',overview:'x',popularity:3}]}),{status:200})})({name:'a'});
 assert.deepEqual(reduced.results[0],{id:1,title:'a',original_title:'b',release_date:'2000-01-01'});
 assert.equal((await tmdbSearchFn({token:'t',fetchImpl:async()=>new Response('x',{status:200})})({name:'a'})).status,502);
}finally{await rm(scratch,{recursive:true,force:true});}
console.log('Letterboxd TMDB search: selection by one movie with the original title and the exact year, review reasons, 4 requests per second and a budget of 1500, the first 403 or 429 ends the run, repeated failures end it, resume, no credential no request, counts only, private output, live catalog directory checks');
