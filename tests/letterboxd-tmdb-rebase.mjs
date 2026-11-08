// AIR-388 B2 (ADR 0105): re-binding an already searched TMDB results file to a newer catalog read, offline. Invented films; no network, no credential.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {crc32} from '../src/letterboxd-zip.js';
import {SEARCH_BASIS} from '../src/letterboxd-tmdb-search.js';
import {main,rebaseResults} from '../scripts/letterboxd-tmdb-search.mjs';
import {plan} from '../scripts/letterboxd-baseline-import.mjs';

function zip(files){
 const locals=[],centrals=[];let offset=0;
 for(const [name,text] of Object.entries(files)){
  const data=Buffer.from(text),body=deflateRawSync(data),nameBytes=Buffer.from(name),crc=crc32(data);
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);local.writeUInt32LE(crc,14);local.writeUInt32LE(body.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(nameBytes.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(8,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(body.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(nameBytes.length,28);central.writeUInt32LE(offset,42);
  locals.push(local,nameBytes,body);centrals.push(central,nameBytes);offset+=30+nameBytes.length+body.length;
 }
 const directory=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,directory,end]);
}

const csv=(header,rows)=>header+'\n'+rows.map(row=>row.join(',')).join('\n')+'\n';
const sha=text=>createHash('sha256').update(text).digest('hex');
const sr=(tmdb,title,year)=>({decision:'inferred_new',tmdb:String(tmdb),title,year,basis:SEARCH_BASIS});
const cat=(id,title,year)=>({id:'tmdb_'+id,tmdbId:String(id),canonicalIdentity:'tmdb:'+id,title,original:title,year,aliases:[]});
const scratch=await mkdtemp(path.join(os.tmpdir(),'iptv-lb-rebase-'));
const realFetch=globalThis.fetch;let networkCalls=0;globalThis.fetch=async()=>{networkCalls++;throw new Error('no network in a rebase');};
try{
 // The export: nine films, none known to the OLD catalog except Known Film.
 const names=[['Kk1','Known Film',2001],['Un1','Becomes Known',2010],['Un2','Stays Unmatched',2011],['Un3','Linked Elsewhere',2012],['Un4','Year Drift Film',2013],['Un5','Existing Later',2014],['Un6','Dup Claim A',2015],['Un7','Dup Claim B',2015],['Un8','Turns Ambiguous',2016],['Un9','Never Searched',2017]];
 const files={
  'watched.csv':csv('Date,Name,Year,Letterboxd URI',names.map(([code,name,year])=>['2024-01-01',name,year,'https://boxd.it/'+code])),
  'ratings.csv':csv('Date,Name,Year,Letterboxd URI,Rating',[['2024-01-01','Known Film','2001','https://boxd.it/Kk1','4']]),
  'watchlist.csv':csv('Date,Name,Year,Letterboxd URI',[]),'diary.csv':csv('Date,Name,Year,Letterboxd URI,Rating,Watched Date',[]),
 };
 const exportDir=path.join(scratch,'export');await mkdir(exportDir);for(const [name,text] of Object.entries(files))await writeFile(path.join(exportDir,name),text);
 const zipPath=path.join(scratch,'letterboxd-demo-user-2026-11-08-13-55-utc.zip');await writeFile(zipPath,zip(files));
 const catalogAt=async(name,readAt,catalog,links={})=>{const dir=path.join(scratch,name);await mkdir(dir);await writeFile(path.join(dir,'catalog.json'),JSON.stringify(catalog));await writeFile(path.join(dir,'links.json'),JSON.stringify(links));await writeFile(path.join(dir,'provenance.json'),JSON.stringify({source:'live_catalog_read',readAt}));return dir;};
 const oldCatalog={tmdb_101:cat(101,'Known Film',2001)};
 const oldDir=await catalogAt('cat-old','2026-11-08T16:16:32.058Z',oldCatalog);

 // The OLD search (made by hand here: the search tool itself is tested in letterboxd-tmdb-search.mjs). 9 recorded attempts, 842 requests in the real run.
 const old={schemaVersion:1,binding:{exportSha256:null,catalogReadAt:'2026-11-08T16:16:32.058Z',catalogFilms:1},requests:842,provenance:{searchedAt:'2026-11-08T19:04:00.000Z',catalog:{source:'live_catalog_read',readAt:'2026-11-08T16:16:32.058Z'}},
  results:{Un1:sr(601,'Becomes Known',2010),Un2:sr(602,'Stays Unmatched',2011),Un3:sr(603,'Linked Elsewhere',2012),Un4:{decision:'review',reason:'year_drift'},Un5:sr(605,'Existing Later',2014),Un6:sr(606,'Dup Claim A',2015),Un7:sr(606,'Dup Claim B',2015),Un8:{decision:'blocked',reason:'http_429'}}};
 // bind it to the real export digest through the tool's own dry-run path
 const dry=await main(['--export',exportDir,'--catalog-dir',oldDir,'--output',path.join(scratch,'o0'),'--dry-run'],{env:{}});assert.equal(dry.unmatched,9);
 const {unmatchedFilms}=await import('../scripts/letterboxd-tmdb-search.mjs');
 const first=await unmatchedFilms({exportDir,catalogDir:oldDir});old.binding.exportSha256=first.exportSha256;
 const oldPath=path.join(scratch,'old-results.json');const oldText=JSON.stringify(old,null,1)+'\n';await writeFile(oldPath,oldText);

 // A stale catalog is a hard failure without the explicit rebase: the planner and the search tool both refuse the old file for the new read.
 // Becomes Known and Existing Later are now Films of the catalog; TMDB 602 (the movie the search chose for Stays Unmatched) is now a Film too, under another name.
 const newCatalog={...oldCatalog,tmdb_201:cat(201,'Becomes Known',2010),tmdb_605:cat(605,'Existing Later',2014),tmdb_602:cat(602,'Totally Other Original',2011)};
 const factLinks={'letterboxd:Zz1':'rec-z','tmdb:603':'rec-z'};   // TMDB 603 is now linked to another Letterboxd code
 const newDir=await catalogAt('cat-new','2026-11-08T19:30:00.000Z',newCatalog,factLinks);
 await assert.rejects(plan({zip:zipPath,catalogDir:newDir,tmdbResults:oldPath,includeInferred:true,output:path.join(scratch,'p-stale'),now:Date.parse('2026-11-09T00:00:00Z')}),/was not made for this export and catalog read/);
 // the search tool refuses the old file for the new read as well, and asks nothing
 const staleOut=path.join(scratch,'stale-out');await mkdir(staleOut);await writeFile(path.join(staleOut,'tmdb-results.json'),oldText);
 await assert.rejects(main(['--export',exportDir,'--catalog-dir',newDir,'--output',staleOut],{env:{TMDB_READ_TOKEN:'t'},fetchImpl:async()=>{networkCalls++;}}),/belongs to another export or catalog read/);
 assert.equal(networkCalls,0);

 // The rebase: same export, newer catalog.
 const outDir=path.join(scratch,'rebased');
 const report=await main(['rebase','--export',exportDir,'--catalog-dir',newDir,'--previous',oldPath,'--output',outDir],{env:{},now:()=>Date.parse('2026-11-08T19:40:00Z')});
 assert.equal(networkCalls,0,'a rebase makes no request');
 assert.equal(report.rebased,true);assert.equal(report.requests,842,'the cumulative request count is kept');assert.equal(report.previousRequests,842);
 assert.deepEqual(report.superseded,{inferred:2},'Becomes Known and Existing Later are now inferred from the catalog');
 assert.deepEqual(report.kept,{inferred_new:3,review:2,blocked:1});
 assert.equal(report.attempts,8);assert.equal(report.carriedSuperseded,0);assert.deepEqual(report.stop,{});
 assert.equal(report.movedToReview.tmdb_linked_elsewhere,1);assert.equal(report.keptInferredNewWithExistingFilm,1,'the search chose a movie the catalog now holds: kept, linked as an existing Film by the planner');
 assert.equal(report.pendingWithoutAttempt,1,'a film with no recorded attempt stays pending and is not searched');
 const printed=JSON.stringify(report);for(const secret of ['Known','Becomes','Linked','Un1','Un3','2010'])assert.ok(!printed.includes(secret),'the report leaks '+secret);
 const rebased=JSON.parse(await readFile(path.join(outDir,'tmdb-results.json'),'utf8'));
 assert.equal(rebased.binding.catalogReadAt,'2026-11-08T19:30:00.000Z');assert.equal(rebased.binding.catalogFilms,4);assert.equal(rebased.binding.exportSha256,old.binding.exportSha256);
 assert.equal(rebased.requests,842);assert.deepEqual(rebased.provenance,old.provenance,'the original search provenance is kept');
 assert.deepEqual(rebased.rebase.original,{binding:old.binding,provenance:old.provenance,requests:842,resultsSha256:sha(oldText)});
 assert.equal(rebased.rebase.rebasedAt,'2026-11-08T19:40:00.000Z');
 assert.ok(!('Un1' in rebased.results)&&!('Un5' in rebased.results),'a film the catalog now knows leaves the results');
 assert.equal(rebased.rebase.superseded.Un1.now,'inferred');assert.deepEqual(rebased.rebase.superseded.Un1.entry,old.results.Un1,'the superseded attempt is kept, unused');
 assert.deepEqual(rebased.results.Un2,old.results.Un2,'an unchanged decision is reused as recorded');
 assert.deepEqual(rebased.results.Un3,{decision:'review',reason:'tmdb_linked_elsewhere'});assert.deepEqual(rebased.rebase.superseded.Un3.entry,old.results.Un3);
 assert.deepEqual(rebased.results.Un4,old.results.Un4);assert.deepEqual(rebased.results.Un8,old.results.Un8,'a blocked attempt stays blocked and is never asked again');
 assert.equal(((await stat(path.join(outDir,'tmdb-results.json'))).mode&0o777),0o600);
 assert.equal(await readFile(oldPath,'utf8'),oldText,'the old file is never rewritten');
 // The rebased file now works with the planner for the NEW catalog read, and says how it got there.
 const planned=await plan({zip:zipPath,catalogDir:newDir,tmdbResults:path.join(outDir,'tmdb-results.json'),includeInferred:true,output:path.join(scratch,'p-new'),now:Date.parse('2026-11-09T00:00:00Z')});
 assert.equal(planned.search.rebase.requests,842);assert.equal(planned.search.rebase.originalCatalogReadAt,'2026-11-08T16:16:32.058Z');
 assert.equal(planned.search.review.tmdb_linked_elsewhere,1);assert.equal(planned.search.review.year_drift,1);
 assert.equal(planned.search.pending,1,'only the film with no attempt is pending');
 assert.equal(planned.search.blocked,1);
 // Un2 is decided and links the Film that now exists (no Film is created); Un6/Un7 claim one TMDB movie and both go to review, as before.
 assert.equal(planned.search.decided,1);assert.equal(planned.filmsToCreate,0);assert.equal(planned.search.review.tmdb_duplicate_in_export,2);
 // Resume after a rebase keeps the rebase block and never asks a recorded code again (one attempt per film, ever).
 const asked=[];
 const resumed=await main(['--export',exportDir,'--catalog-dir',newDir,'--output',outDir,'--auth','proxy'],{env:{},fetchImpl:async url=>{asked.push(new URL(url).searchParams.get('query'));return new Response(JSON.stringify({results:[]}),{status:200});},sleep:async()=>{},now:()=>1});
 assert.deepEqual(asked,['Never Searched'],'only the film that has no recorded attempt is asked');
 assert.ok(!asked.includes('Becomes Known')&&!asked.includes('Stays Unmatched')&&!asked.includes('Linked Elsewhere'),'a recorded or superseded code is not requested');
 assert.equal(resumed.totalRequests,843);
 const after=JSON.parse(await readFile(path.join(outDir,'tmdb-results.json'),'utf8'));assert.equal(after.rebase.original.requests,842,'the original provenance survives a resume');

 // Refusals, all fail closed with nothing written.
 const refuse=async(args,pattern,name)=>{const out=path.join(scratch,'r-'+name);await assert.rejects(main(['rebase','--export',args.exportDir??exportDir,'--catalog-dir',args.catalogDir??newDir,'--previous',args.previous??oldPath,'--output',out],{env:{}}),pattern);await assert.rejects(stat(path.join(out,'tmdb-results.json')));};
 // the same catalog read: nothing to rebase
 await refuse({catalogDir:oldDir},/nothing to rebase/,'same');
 // another export: a different digest
 const otherExport=path.join(scratch,'export2');await mkdir(otherExport);for(const [name,text] of Object.entries(files))await writeFile(path.join(otherExport,name),name==='watched.csv'?text+'2024-02-02,Extra Film,2020,https://boxd.it/Ex1\n':text);
 await refuse({exportDir:otherExport},/same export digest/,'export');
 // a recorded entry whose title or year no longer agrees with its export film is tampering or a wrong file: STOP
 const bad=JSON.parse(oldText);bad.results.Un2=sr(602,'Another Title',2011);const badPath=path.join(scratch,'bad-title.json');await writeFile(badPath,JSON.stringify(bad));
 await refuse({previous:badPath},/title_or_year_mismatch/,'title');
 const badYear=JSON.parse(oldText);badYear.results.Un2=sr(602,'Stays Unmatched',2012);const badYearPath=path.join(scratch,'bad-year.json');await writeFile(badYearPath,JSON.stringify(badYear));
 await refuse({previous:badYearPath},/title_or_year_mismatch/,'year');
 // a film that is now ambiguous in the catalog (two Films, one title and year): STOP, not silently superseded
 const ambiguousDir=await catalogAt('cat-amb','2026-11-08T19:31:00.000Z',{...newCatalog,tmdb_801:cat(801,'Turns Ambiguous',2016),tmdb_802:cat(802,'Turns Ambiguous',2016)},factLinks);
 await refuse({catalogDir:ambiguousDir},/now_ambiguous/,'ambiguous');
 // a recorded code that is not in the export
 const stray=JSON.parse(oldText);stray.results.Zz9=sr(999,'Not In Export',2000);const strayPath=path.join(scratch,'stray.json');await writeFile(strayPath,JSON.stringify(stray));
 await refuse({previous:strayPath},/code_not_in_export/,'stray');
 // an unknown schema, and an output directory that already holds a results file
 const odd=path.join(scratch,'odd.json');await writeFile(odd,JSON.stringify({schemaVersion:2,results:{}}));await refuse({previous:odd},/unknown schema/,'schema');
 await assert.rejects(main(['rebase','--export',exportDir,'--catalog-dir',newDir,'--previous',oldPath,'--output',outDir],{env:{}}),/already holds a tmdb-results\.json/);
 // usage: the search options do not belong to a rebase, and --previous does not belong to a search
 await assert.rejects(main(['rebase','--export',exportDir,'--catalog-dir',newDir,'--output',path.join(scratch,'u1')],{env:{}}),/Usage/);
 await assert.rejects(main(['rebase','--export',exportDir,'--catalog-dir',newDir,'--previous',oldPath,'--output',path.join(scratch,'u2'),'--dry-run'],{env:{}}),/Usage/);
 await assert.rejects(main(['--export',exportDir,'--catalog-dir',newDir,'--previous',oldPath,'--output',path.join(scratch,'u3'),'--dry-run'],{env:{}}),/belongs to the rebase command/);
 await assert.rejects(main(['rebase','--export',exportDir,'--catalog-dir',newDir,'--previous','tests/old.json','--output',path.join(scratch,'u4')],{env:{}}),/absolute|outside/);

 // ---- Three catalog reads: unmatched -> known -> unmatched again. The first attempt is durable across every rebase (one attempt per code, ever). ----
 // Read 2 (newDir) knew Becomes Known (Un1): rebase #1 moved its attempt to `rebase.superseded`. Read 3 no longer knows it.
 const rebase1Text=await readFile(path.join(outDir,'tmdb-results.json'),'utf8');const rebase1=JSON.parse(rebase1Text);
 assert.ok('Un1' in rebase1.rebase.superseded&&!('Un1' in rebase1.results));assert.equal(rebase1.rebase.steps.length,1);assert.equal(rebase1.requests,843,'the resume above spent one request on the film with no attempt');
 const catalog3={...oldCatalog,tmdb_605:cat(605,'Existing Later',2014),tmdb_602:cat(602,'Totally Other Original',2011)};
 const read3=await catalogAt('cat-3','2026-11-08T19:50:00.000Z',catalog3,factLinks);
 const out2=path.join(scratch,'rebased-2');
 const report2=await main(['rebase','--export',exportDir,'--catalog-dir',read3,'--previous',path.join(outDir,'tmdb-results.json'),'--output',out2],{env:{},now:()=>Date.parse('2026-11-08T19:55:00Z')});
 assert.equal(networkCalls,0);assert.equal(report2.restored,1,'the superseded attempt is judged again and restored');assert.equal(report2.pendingWithoutAttempt,0,'a code attempted before is never pending');
 assert.equal(report2.requests,843);assert.equal(report2.steps,2);assert.equal(report2.attempts,9);
 const rebased2=JSON.parse(await readFile(path.join(out2,'tmdb-results.json'),'utf8'));
 assert.deepEqual(rebased2.results.Un1,old.results.Un1,'the saved decision is restored as recorded');assert.ok(!('Un1' in rebased2.rebase.superseded),'a restored code is no longer superseded');
 assert.equal(rebased2.rebase.superseded.Un5.now,'inferred');assert.deepEqual(rebased2.rebase.superseded.Un5.entry,old.results.Un5,'a code still known keeps its root attempt through the second rebase');
 assert.equal(rebased2.rebase.superseded.Un3.now,'unmatched');assert.deepEqual(rebased2.rebase.superseded.Un3.entry,old.results.Un3,'the root attempt behind a review is kept');assert.deepEqual(rebased2.results.Un3,{decision:'review',reason:'tmdb_linked_elsewhere'});
 // the root provenance is the first search, not the previous hop; every hop is traceable
 assert.deepEqual(rebased2.rebase.original,{binding:old.binding,provenance:old.provenance,requests:842,resultsSha256:sha(oldText)},'the root provenance and the first source digest are never replaced');
 assert.equal(rebased2.rebase.steps.length,2);assert.equal(rebased2.rebase.steps[0].fromResultsSha256,sha(oldText));assert.equal(rebased2.rebase.steps[1].fromResultsSha256,sha(rebase1Text));assert.equal(rebased2.rebase.steps[1].from.catalogReadAt,'2026-11-08T19:30:00.000Z');
 assert.deepEqual(rebased2.provenance,old.provenance);
 // the normal search command on read 3 asks for NO code at all: not the restored one, not a superseded one, not a recorded one
 const askedAfter=[];
 const searchAfter=await main(['--export',exportDir,'--catalog-dir',read3,'--output',out2,'--auth','proxy'],{env:{},fetchImpl:async url=>{askedAfter.push(new URL(url).searchParams.get('query'));return new Response(JSON.stringify({results:[]}),{status:200});},sleep:async()=>{},now:()=>1});
 assert.deepEqual(askedAfter,[],'zero repeat requests after three catalog reads');assert.equal(searchAfter.requests,0);assert.equal(searchAfter.totalRequests,843);
 const dryAfter=await main(['--export',exportDir,'--catalog-dir',read3,'--output',out2,'--dry-run'],{env:{}});assert.equal(dryAfter.requestsWouldBeMade,0);
 // even a superseded code that the catalog would call unmatched is barred in the search command (defence in depth against a hand-edited file)
 {
  const tampered=JSON.parse(await readFile(path.join(out2,'tmdb-results.json'),'utf8'));tampered.rebase.superseded.Un1={now:'inferred',entry:old.results.Un1};delete tampered.results.Un1;
  const tamperedDir=path.join(scratch,'tampered-out');await mkdir(tamperedDir);await writeFile(path.join(tamperedDir,'tmdb-results.json'),JSON.stringify(tampered));
  const askedT=[];await main(['--export',exportDir,'--catalog-dir',read3,'--output',tamperedDir,'--auth','proxy'],{env:{},fetchImpl:async url=>{askedT.push(new URL(url).searchParams.get('query'));return new Response(JSON.stringify({results:[]}),{status:200});},sleep:async()=>{},now:()=>1});
  assert.deepEqual(askedT,[],'a superseded code is never asked');
 }
 // Read 4: the link that sent Linked Elsewhere to review is gone: the root attempt is judged again and its decision is restored, never pending.
 const read4=await catalogAt('cat-4','2026-11-08T20:10:00.000Z',catalog3,{});
 const out3=path.join(scratch,'rebased-3');
 const report3=await main(['rebase','--export',exportDir,'--catalog-dir',read4,'--previous',path.join(out2,'tmdb-results.json'),'--output',out3],{env:{},now:()=>Date.parse('2026-11-08T20:15:00Z')});
 assert.equal(report3.pendingWithoutAttempt,0);assert.equal(report3.steps,3);
 const rebased3=JSON.parse(await readFile(path.join(out3,'tmdb-results.json'),'utf8'));
 assert.deepEqual(rebased3.results.Un3,old.results.Un3,'the original decision comes back once the conflict is gone');assert.ok(!('Un3' in rebased3.rebase.superseded));assert.equal(rebased3.rebase.original.resultsSha256,sha(oldText));
 // A code recorded twice, or more attempts than requests, stops the rebase.
 {
  const twice=JSON.parse(await readFile(path.join(out2,'tmdb-results.json'),'utf8'));twice.results.Un5=old.results.Un5;
  const twicePath=path.join(scratch,'twice.json');await writeFile(twicePath,JSON.stringify(twice));await refuse({previous:twicePath,catalogDir:read4},/attempt_recorded_twice/,'twice');
  const fewer=JSON.parse(await readFile(path.join(out2,'tmdb-results.json'),'utf8'));fewer.requests=2;
  const fewerPath=path.join(scratch,'fewer.json');await writeFile(fewerPath,JSON.stringify(fewer));await refuse({previous:fewerPath,catalogDir:read4},/more_attempts_than_requests/,'fewer');
  const odd2=JSON.parse(await readFile(path.join(out2,'tmdb-results.json'),'utf8'));odd2.rebase.steps='x';
  const odd2Path=path.join(scratch,'odd2.json');await writeFile(odd2Path,JSON.stringify(odd2));await refuse({previous:odd2Path,catalogDir:read4},/unknown rebase block/,'oddblock');
 }
 // The plan from the twice-rebased file says how many steps led there.
 const plannedAfter=await plan({zip:zipPath,catalogDir:read3,tmdbResults:path.join(out2,'tmdb-results.json'),includeInferred:true,output:path.join(scratch,'p-after'),now:Date.parse('2026-11-09T00:00:00Z')});
 assert.equal(plannedAfter.search.rebase.steps,2);assert.equal(plannedAfter.search.rebase.originalCatalogReadAt,'2026-11-08T16:16:32.058Z');assert.equal(plannedAfter.search.rebase.requests,843);
 assert.equal(networkCalls,0,'no refusal path reached the network');
 assert.equal(typeof rebaseResults,'function');
}finally{globalThis.fetch=realFetch;await rm(scratch,{recursive:true,force:true});}
console.log('Letterboxd TMDB rebase: a stale catalog read is a hard failure without the explicit rebase; the rebase is offline, keeps the 842 requests and the original provenance, supersedes what the new catalog knows, sends a newly linked TMDB movie to review, stops on an ambiguous film, a title or year mismatch or a foreign export, the old file is never rewritten, and after three catalog reads (unmatched, known, unmatched) the attempt is still durable, restored under the same checks, never pending, never searched twice, with the root provenance intact.');
