// Letterboxd identity resolver with invented data and an injected fetch only: no request leaves this process.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {appendFile,cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {allowedHop,buildQueue,decide,isChallenge,isFilmPage,pageEvidence} from '../src/letterboxd-identity.js';
import {POLICY,ResolveError,loadPageTools,resolve} from '../scripts/letterboxd-identity-resolve.mjs';

const scratch=await mkdtemp(path.join(os.tmpdir(),'lbx-identity-'));
const tools=loadPageTools();

// An invented Letterboxd film page in the shape parseFilm reads.
function page({code,title,year,tmdb='',type='movie',aliases=[],slug,ogYear=year,ldYear=year,shortlink=code,canonical=slug}){
 const ld=JSON.stringify({name:title,...(ldYear?{releasedEvent:[{'@type':'PublicationEvent',startDate:String(ldYear)}]}:{})});
 return '<html><head>'+(canonical?'<link rel="canonical" href="https://letterboxd.com/film/'+canonical+'/">':'')+(shortlink?'<link rel="shortlink" href="https://boxd.it/'+shortlink+'">':'')
  +'<meta property="og:title" content="'+title+(ogYear?' ('+ogYear+')':'')+'">'
  +'<script type="application/ld+json">/* <![CDATA[ */'+ld+'/* ]]> */</script></head>'
  +'<body class="film" '+(type?'data-tmdb-type="'+type+'" ':'')+(tmdb?'data-tmdb-id="'+tmdb+'"':'')+'>'
  +(aliases.length?'<h3><span>Alternative Titles</span></h3>\n<div class="text-indentedlist">\n<p>'+aliases.join(', ')+'</p></div>':'')+'</body></html>';
}
const headers=map=>({get:key=>map[key.toLowerCase()]??null});
const redirect=location=>({status:301,headers:headers({location}),html:''});
const ok=html=>({status:200,headers:headers({}),html});

// Ledger rows and the film each code's shortlink lands on.
const films=[
 // code, ledger status, export name, export year, ledger tmdb, page (null: the web map sets it)
 ['Zq01','candidate','Invented Alpha',2001,'900001',{title:'Invented Alpha',year:2001,tmdb:'900001'}],
 ['Zq02','candidate','Invented Beta',2002,null,{title:'Invented Beta',year:2002,tmdb:'900002',shortlink:'Zq99'}],
 ['Zq03','unmatched','Invented Gamma',2003,null,{title:'Invented Gamma',year:2003}],
 ['Zq04','candidate','Remade Story',2004,'900040',{title:'Remade Story',year:2004,tmdb:'900041'}],
 ['Zq05','unmatched','Twin Picture',2005,null,{title:'Twin Picture',year:2005,tmdb:'900005'}],
 ['Zq06','unmatched','Twin Picture',2005,null,{title:'Twin Picture',year:2005,tmdb:'900006'}],
 ['Zq07','unmatched','Near Year',2007,null,{title:'Near Year',year:2008,tmdb:'900007'}],
 ['Zq08','unmatched','Far Year',2008,null,{title:'Far Year',year:2012,tmdb:'900008'}],
 ['Zq09','unmatched','Invented Alias',2009,null,{title:'Original Name',year:2009,tmdb:'900009',aliases:['Invented Alias','Other']}],
 ['Zq10','unmatched','Invented Kappa',2010,null,{title:'Something Else',year:2010,tmdb:'900010'}],
 ['Zq11','unmatched','Dup One',2011,null,{title:'Dup One',year:2011,tmdb:'900111'}],
 ['Zq12','unmatched','Dup Two',2012,null,{title:'Dup Two',year:2012,tmdb:'900111'}],
 ['Zq13','unmatched','Already There',2013,null,{title:'Already There',year:2013,tmdb:'900500'}],
 ['Zq14','unmatched','Imported Code',2014,null,null],
 ['Zq15','ambiguous','Ambiguous Story',2015,null,{title:'Ambiguous Story',year:2015,tmdb:'900015'}],
 ['Zq16','unmatched','Series Thing',2016,null,{title:'Series Thing',year:2016,tmdb:'900016',type:'tv'}],
 ['Zq17','unmatched','Off Site',2017,null,null],
 ['Zq18','unmatched','Not A Film',2018,null,null],
 ['Zq19','unmatched','Gone Film',2019,null,null],
 ['Zq20','unmatched','No Year Export',null,null,{title:'No Year Export',year:2020,tmdb:'900020'}],
 ['Zq21','unmatched','Mixed Years',2021,null,{title:'Mixed Years',year:2021,ogYear:2021,ldYear:2022,tmdb:'900021'}],
 ['Zq22','unmatched','Wrong Canonical',2022,null,{title:'Wrong Canonical',year:2022,tmdb:'900022',canonical:'another-film'}],
];
const slugOf=code=>'invented-'+code.toLowerCase();
const ledgerRows=[
 {type:'invalid_row',file:'watched.csv',record:9,reason:'invalid_uri'},
 {type:'match',code:'Zq00',status:'accepted',name:'Imported Earlier',year:2000,filmId:'Zq00',tmdbId:'900500'},
 {type:'match',code:'../x',status:'unmatched',name:'Bad Code',year:2000},
 ...films.map(([code,status,name,year,tmdbId])=>({type:'match',code,basis:'title',status,method:null,reason:'x',filmId:null,tmdbId,catalogIds:[],candidates:[],evidence:{},uri:'https://boxd.it/'+code,name,year,rating:4,sets:['watched']})),
];
const planRows=[{chunk:0,item:{lid:'Zq00',tmdb:'900500',facts:{watched:true}}},{chunk:0,item:{lid:'Zq14',tmdb:null,facts:{watched:true}}}];
function web(){
 const map=new Map();
 for(const [code,,,,,film] of films){
  if(!film)continue;
  map.set('https://boxd.it/'+code,redirect('https://letterboxd.com/film/'+slugOf(code)+'/'));
  map.set('https://letterboxd.com/film/'+slugOf(code)+'/',ok(page({code,slug:slugOf(code),...film})));
 }
 map.set('https://boxd.it/Zq17',redirect('https://elsewhere.example/film/x/'));
 map.set('https://boxd.it/Zq18',redirect('https://letterboxd.com/'));
 map.set('https://letterboxd.com/',ok('<html>home</html>'));
 map.set('https://boxd.it/Zq19',{status:404,headers:headers({}),html:'not found'});
 return map;
}
// A fetch over the map with a virtual clock; it records request times and checks that requests never overlap.
function fakeNet(map,{hooks={}}={}){
 const net={t:0,calls:[],inflight:0,maxInflight:0};
 net.now=()=>net.t;net.sleep=async ms=>{net.t+=ms;};
 net.fetch=async(url,init)=>{
  assert.equal(init.redirect,'manual');assert.ok(init.signal);
  net.calls.push({url,t:net.t});net.inflight++;net.maxInflight=Math.max(net.maxInflight,net.inflight);
  try{
   if(hooks[url])return await hooks[url](init,net);
   const spec=map.get(url);if(!spec)throw new Error('unexpected url');
   return {status:spec.status,headers:spec.headers,text:async()=>spec.html};
  }finally{net.inflight--;net.t+=5;}
 };
 return net;
}
async function files(dir,ledger=ledgerRows,plan=planRows){
 await writeFile(path.join(dir,'matches.jsonl'),ledger.map(row=>JSON.stringify(row)).join('\n')+'\n');
 await writeFile(path.join(dir,'plan.jsonl'),plan.map(row=>JSON.stringify(row)).join('\n')+'\n');
 return {ledger:path.join(dir,'matches.jsonl'),imported:path.join(dir,'plan.jsonl'),output:path.join(dir,'out')};
}
const readRows=async file=>(await readFile(file,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
const byCode=rows=>new Map(rows.map(row=>[row.code,row]));

// Pure helpers.
assert.equal(allowedHop('https://letterboxd.com/film/x/','https://boxd.it/a')?.hostname,'letterboxd.com');
assert.equal(allowedHop('http://letterboxd.com/film/x/','https://boxd.it/a'),null);
assert.equal(allowedHop('https://letterboxd.com.evil.example/','https://boxd.it/a'),null);
assert.equal(allowedHop('https://user@letterboxd.com/film/x/','https://boxd.it/a'),null);
assert.ok(isFilmPage(new URL('https://letterboxd.com/film/invented-a/')));
assert.ok(!isFilmPage(new URL('https://letterboxd.com/film/invented-a/reviews/')));
assert.ok(!isFilmPage(new URL('https://letterboxd.com/list/x/')));
assert.ok(isChallenge(200,headers({'cf-mitigated':'challenge'}),'<html></html>'));
assert.ok(isChallenge(200,headers({}),'<html><title>Just a moment...</title></html>'));
assert.ok(isChallenge(503,headers({}),'<script src="/cdn-cgi/challenge-platform/x"></script>'));
assert.ok(!isChallenge(200,headers({}),page({code:'Zq01',title:'Invented Alpha',year:2001,tmdb:'1',slug:'a'})));
const evidence=pageEvidence(page({code:'Zq09',title:'Original Name',year:2009,tmdb:'900009',aliases:['Invented Alias'],slug:'s'}),new URL('https://letterboxd.com/film/s/'),tools);
assert.deepEqual({...evidence},{kind:'page',path:'/film/s/',shortCode:'Zq09',shortlinkPresent:true,canonicalPath:'/film/s/',tmdbIds:['900009'],tmdbTypes:['movie'],title:'Original Name',aliases:['Invented Alias'],years:[2009]});
assert.equal(pageEvidence('<html>no metadata</html>',new URL('https://letterboxd.com/film/s/'),tools).kind,'unparsable_page');
assert.deepEqual(pageEvidence(page({code:'A1',title:'T',year:2000,tmdb:'1',slug:'s'}).replace('</body>','<div data-tmdb-id="2"></div></body>'),new URL('https://letterboxd.com/film/s/'),tools).tmdbIds,['1','2']);

// Queue: accepted ledger rows, already imported codes and invalid codes are not queued; candidates and ambiguous rows first.
const built=buildQueue(ledgerRows,planRows.map(row=>row.item));
assert.deepEqual(built.counts,{ledgerMatches:films.length+2,acceptedInLedger:1,alreadyImported:1,invalidCode:1,duplicateCode:0,queued:films.length-1});
assert.deepEqual(built.queue.slice(0,4).map(entry=>entry.code),['Zq01','Zq02','Zq04','Zq15']);
assert.ok(!built.queue.some(entry=>entry.code==='Zq14'||entry.code==='Zq00'));
assert.equal(decide(built.queue,new Map(),built).every(row=>row.decision==='pending'),true);

// Without --network nothing is fetched: decisions stay pending.
{
 const dir=await mkdtemp(path.join(scratch,'offline-')),paths=await files(dir);
 const report=await resolve({...paths,fetchImpl:()=>{throw new Error('network must not be used');}});
 assert.equal(report.network.enabled,false);assert.equal(report.network.requests,0);
 assert.equal(report.byDecision.pending,films.length-1);assert.equal(report.complete,false);
 await assert.rejects(resolve({...paths,network:true}),error=>error instanceof ResolveError&&error.exitCode===2);
}

// A full run with the invented web.
const dir=await mkdtemp(path.join(scratch,'full-')),paths=await files(dir),net=fakeNet(web()),logs=[];
const report=await resolve({...paths,network:true,fetchImpl:net.fetch,now:net.now,sleep:net.sleep,tools,log:line=>logs.push(line)});
const rows=byCode(await readRows(path.join(paths.output,'resolution.jsonl')));
const expect=(code,decision,reasons)=>{const row=rows.get(code);assert.equal(row.decision,decision,code);if(reasons)assert.deepEqual(row.reasons,reasons,code);};
expect('Zq01','accepted',[]);assert.equal(rows.get('Zq01').tmdbId,'900001');assert.equal(rows.get('Zq01').method,'letterboxd_page');
expect('Zq02','conflict',['shortlink_mismatch']);
expect('Zq03','owner_review',['tmdb_missing']);
expect('Zq04','owner_review',['ledger_candidate_differs']);
expect('Zq05','owner_review',['same_title_year']);expect('Zq06','owner_review',['same_title_year']);
expect('Zq07','owner_review',['year_off_by_one']);
expect('Zq08','conflict',['year_disagrees']);
expect('Zq09','owner_review',['title_alias_only']);
expect('Zq10','conflict',['title_differs']);
expect('Zq11','conflict',['duplicate_tmdb']);expect('Zq12','conflict',['duplicate_tmdb']);
expect('Zq13','conflict',['tmdb_already_imported']);
expect('Zq15','owner_review',['ledger_ambiguous']);
expect('Zq16','owner_review',['tmdb_not_movie']);
expect('Zq17','owner_review',['redirect_off_site']);
expect('Zq18','owner_review',['not_film_page']);
expect('Zq19','owner_review',['not_found']);
expect('Zq20','owner_review',['export_year_missing']);
expect('Zq21','owner_review',['page_year_inconsistent']);
expect('Zq22','conflict',['canonical_mismatch']);
assert.ok(!rows.has('Zq14')&&!rows.has('Zq00')&&!rows.has('../x'));
for(const row of rows.values())if(row.decision!=='accepted')assert.equal(row.tmdbId,null);
assert.equal(report.complete,true);assert.equal(report.byDecision.accepted,1);
assert.equal(report.byGroup.candidate.accepted,1);
// Rate and concurrency: one request at a time, request starts at least a second apart, every hop counted.
assert.equal(net.maxInflight,1);
for(let i=1;i<net.calls.length;i++)assert.ok(net.calls[i].t-net.calls[i-1].t>=POLICY.minIntervalMs,'requests are paced');
assert.ok(net.calls.every(call=>/^https:\/\/(boxd\.it|letterboxd\.com)\//.test(call.url)),'only Letterboxd hosts are requested');
assert.ok(!net.calls.some(call=>call.url.includes('elsewhere.example')),'an off-site redirect is not followed');
assert.equal(report.network.requests,net.calls.length);
// Order: candidates, then ambiguous, then unmatched.
assert.deepEqual(net.calls.filter(call=>call.url.startsWith('https://boxd.it/')).slice(0,5).map(call=>call.url.slice(16)),['Zq01','Zq02','Zq04','Zq15','Zq03']);

// Redaction: the report and log lines carry no code, name, path or TMDB id.
const reportText=await readFile(path.join(paths.output,'report.json'),'utf8');
for(const text of [reportText,...logs])for(const [code,,name,,,film] of films){
 assert.ok(!text.includes(code),'no code');assert.ok(!text.includes(name),'no name');assert.ok(!text.includes(slugOf(code)),'no path');
 if(film?.tmdb)assert.ok(!text.includes(film.tmdb),'no TMDB id');
}

// A rerun is resumable and idempotent: everything is in the checkpoint, nothing is fetched again.
{
 const again=fakeNet(web());
 const second=await resolve({...paths,network:true,fetchImpl:again.fetch,now:again.now,sleep:again.sleep,tools});
 assert.equal(again.calls.length,0);assert.deepEqual(second.byDecision,report.byDecision);
 assert.equal(await readFile(path.join(paths.output,'resolution.jsonl'),'utf8'),[...rows.values()].map(row=>JSON.stringify(row)).join('\n')+'\n');
}
// The checkpoint is bound to its ledger and plan.
{
 const changed=await files(await mkdtemp(path.join(scratch,'bind-')),ledgerRows,planRows.slice(0,1));
 await mkdir(changed.output);await cp(path.join(paths.output,'checkpoint.jsonl'),path.join(changed.output,'checkpoint.jsonl'));
 await assert.rejects(resolve({...changed}),error=>error instanceof ResolveError&&error.exitCode===3);
}

// Stop on 429, 403 and a challenge: the run ends, the stopped code is not recorded, and a later run resumes from it.
for(const [label,spec,reason] of [
 ['429',{status:429,headers:headers({}),html:''},'rate_limited'],
 ['403',{status:403,headers:headers({}),html:''},'forbidden'],
 ['challenge',{status:200,headers:headers({'cf-mitigated':'challenge'}),html:'<html><title>Just a moment...</title></html>'},'challenge'],
 ['challenge-503',{status:503,headers:headers({}),html:'<div id="cf-chl-widget"></div>'},'challenge'],
]){
 const stopDir=await mkdtemp(path.join(scratch,'stop-'+label+'-')),stopPaths=await files(stopDir),map=web();
 map.set('https://boxd.it/Zq15',spec);
 const first=fakeNet(map),stopped=await resolve({...stopPaths,network:true,fetchImpl:first.fetch,now:first.now,sleep:first.sleep,tools});
 assert.equal(stopped.network.stopReason,reason,label);
 assert.equal(stopped.network.retries,0,'a stop is never retried');
 assert.equal(first.calls.filter(call=>call.url==='https://boxd.it/Zq15').length,1);
 assert.equal(first.calls.at(-1).url,'https://boxd.it/Zq15','nothing is requested after a stop');
 assert.equal(stopped.network.observedThisRun,3);assert.equal(stopped.complete,false);
 const checkpoint=await readFile(path.join(stopPaths.output,'checkpoint.jsonl'),'utf8');assert.ok(!checkpoint.includes('Zq15'));
 const resumed=fakeNet(web()),done=await resolve({...stopPaths,network:true,fetchImpl:resumed.fetch,now:resumed.now,sleep:resumed.sleep,tools});
 assert.equal(resumed.calls[0].url,'https://boxd.it/Zq15','resume starts at the stopped code');
 assert.ok(!resumed.calls.some(call=>/Zq0[124]$/.test(call.url)),'observed codes are not fetched again');
 assert.equal(done.complete,true);assert.deepEqual(done.byDecision,report.byDecision);
}

// A truncated last checkpoint line (an interrupted write) is ignored and that code is fetched again.
{
 const cutDir=await mkdtemp(path.join(scratch,'cut-')),cutPaths=await files(cutDir),first=fakeNet(web());
 await resolve({...cutPaths,network:true,limit:2,fetchImpl:first.fetch,now:first.now,sleep:first.sleep,tools});
 await appendFile(path.join(cutPaths.output,'checkpoint.jsonl'),'{"type":"observation","code":"Zq04","obs');
 const next=fakeNet(web()),done=await resolve({...cutPaths,network:true,fetchImpl:next.fetch,now:next.now,sleep:next.sleep,tools});
 assert.equal(next.calls[0].url,'https://boxd.it/Zq04');assert.equal(done.complete,true);
}

// --limit bounds one run.
{
 const limitPaths=await files(await mkdtemp(path.join(scratch,'limit-'))),limited=fakeNet(web());
 const partial=await resolve({...limitPaths,network:true,limit:2,fetchImpl:limited.fetch,now:limited.now,sleep:limited.sleep,tools});
 assert.equal(partial.network.observedThisRun,2);assert.equal(partial.network.limitReached,true);assert.equal(partial.byDecision.pending,films.length-3);
}

// Timeouts and retries are bounded: a hanging request is aborted, retried at most maxRetries times, then left pending; three
// failing codes in a row stop the run. A transient 5xx followed by success is accepted.
{
 const hangDir=await mkdtemp(path.join(scratch,'hang-')),hangPaths=await files(hangDir),hang=(init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('aborted'))));
 const flaky={count:0};
 const net2=fakeNet(web(),{hooks:{
  'https://boxd.it/Zq01':async(init,net)=>{if(flaky.count++===0)return {status:502,headers:headers({}),text:async()=>'bad gateway'};const spec=web().get('https://boxd.it/Zq01');return {status:spec.status,headers:spec.headers,text:async()=>''};},
  'https://boxd.it/Zq02':hang,'https://boxd.it/Zq04':hang,'https://boxd.it/Zq15':hang,
 }});
 const result=await resolve({...hangPaths,network:true,fetchImpl:net2.fetch,now:net2.now,sleep:net2.sleep,tools,policy:{timeoutMs:20}});
 const out=byCode(await readRows(path.join(hangPaths.output,'resolution.jsonl')));
 assert.equal(out.get('Zq01').decision,'accepted');
 for(const code of ['Zq02','Zq04','Zq15']){assert.deepEqual(out.get(code).reasons,['fetch_failed']);assert.equal(net2.calls.filter(call=>call.url==='https://boxd.it/'+code).length,POLICY.maxRetries+1);}
 assert.equal(result.network.stopReason,'consecutive_failures');
 assert.equal(result.network.retries,1+3*POLICY.maxRetries);
 // Failed codes are retried by the next run.
 const net3=fakeNet(web()),later=await resolve({...hangPaths,network:true,fetchImpl:net3.fetch,now:net3.now,sleep:net3.sleep,tools});
 assert.equal(net3.calls[0].url,'https://boxd.it/Zq02');assert.equal(later.complete,true);
}

// The command line: paths must be absolute and outside the repository; without --network it sends nothing and prints counts.
{
 const cli=args=>spawnSync(process.execPath,['scripts/letterboxd-identity-resolve.mjs',...args],{encoding:'utf8'});
 assert.equal(cli(['--ledger',paths.ledger,'--imported',paths.imported,'--output',path.resolve('tmp-identity-out')]).status,2);
 assert.equal(cli(['--ledger','matches.jsonl','--imported',paths.imported,'--output',paths.output]).status,2);
 assert.equal(cli(['--ledger',paths.ledger,'--imported',paths.imported,'--output',paths.output,'--limit','0']).status,2);
 const run=cli(['--ledger',paths.ledger,'--imported',paths.imported,'--output',paths.output]);
 assert.equal(run.status,0,run.stderr);
 const printed=JSON.parse(run.stdout);assert.equal(printed.network.enabled,false);assert.equal(printed.complete,true);
 for(const [code,,name] of films){assert.ok(!run.stdout.includes(code)&&!run.stderr.includes(code));assert.ok(!run.stdout.includes(name));}
}

await rm(scratch,{recursive:true,force:true});
console.log('Letterboxd identity resolver: evidence chain, conflicts, network policy, stops, resume and redaction passed');
