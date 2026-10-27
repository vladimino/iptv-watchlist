import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import fs from 'node:fs';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {deflateRawSync} from 'node:zlib';
import {archiveGeneratedAt,crc32,readZip} from '../src/letterboxd-zip.js';
import {loadVerifiedPlan,plan,planItem,remote} from '../scripts/letterboxd-baseline-import.mjs';

const sha256=value=>createHash('sha256').update(value).digest('hex');
// A minimal ZIP writer for invented test files: stored or deflated entries, optional corruptions.
function zip(files,{deflate=true,encrypt=false,badCrc=false}={}){
 const locals=[],centrals=[];let offset=0;
 for(const [name,text] of Object.entries(files)){
  const data=Buffer.from(text),body=deflate?deflateRawSync(data):data,nameBytes=Buffer.from(name),crc=badCrc?(crc32(data)^1)>>>0:crc32(data);
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(encrypt?1:0,6);local.writeUInt16LE(deflate?8:0,8);local.writeUInt32LE(crc,14);local.writeUInt32LE(body.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(nameBytes.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(encrypt?1:0,8);central.writeUInt16LE(deflate?8:0,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(body.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(nameBytes.length,28);central.writeUInt32LE(offset,42);
  locals.push(local,nameBytes,body);centrals.push(central,nameBytes);offset+=30+nameBytes.length+body.length;
 }
 const directory=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,directory,end]);
}

// ZIP reader and archive name.
{
 const files={'watched.csv':'a,b\n1,2\n','other.txt':'x'};
 for(const deflate of [true,false]){const read=readZip(zip(files,{deflate}),['watched.csv','ratings.csv']);assert.equal(read.files['watched.csv'].text,'a,b\n1,2\n');assert.equal(read.files['ratings.csv'],undefined);assert.equal(read.files['other.txt'],undefined);}
 assert.throws(()=>readZip(zip(files,{badCrc:true}),['watched.csv']),/checksum/);
 assert.throws(()=>readZip(zip(files,{encrypt:true}),['watched.csv']),/Encrypted/);
 assert.throws(()=>readZip(Buffer.from('not a zip at all, definitely not'),['watched.csv']),/end of central directory/);
 assert.equal(archiveGeneratedAt('/x/letterboxd-demo-user-2026-10-26-13-48-utc.zip'),'2026-10-26T13:48:00.000Z');
 assert.equal(archiveGeneratedAt('letterboxd-demo-user-2026-02-30-13-48-utc.zip'),null);
 assert.equal(archiveGeneratedAt('export.zip'),null);
}
// An accepted film's facts: a rating implies watched; watched without a rating is "not rated"; absence is never false.
assert.deepEqual(planItem({inWatched:true,inRatings:true,rating:4.5,inWatchlist:false,watchedDate:'2024-05-01'},{filmId:'Ab1',tmdbId:'949'}),{lid:'Ab1',tmdb:'949',facts:{watched:true,rating:4.5},effectiveOn:{watched:'2024-05-01'}});
assert.deepEqual(planItem({inWatched:true,inRatings:false,inWatchlist:true},{filmId:'Cd2',tmdbId:null}).facts,{watched:true,rating:null,watchlist:true});
assert.deepEqual(planItem({inWatched:false,inRatings:false,inWatchlist:true},{filmId:'Ef3',tmdbId:null}).facts,{watchlist:true});

// A CAS bucket with optional one-shot failures, and the Worker module in a context of its own.
function bucket(){
 const records=new Map(),etags=new Map();let revision=0,puts=0,fail=null;
 return {records,get puts(){return puts;},failOnce(predicate){fail=predicate;},
  async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
  async put(key,value,options={}){if(fail&&fail(key)){fail=null;throw new Error('injected failure: '+key);}const c=options.onlyIf||{};if(c.etagDoesNotMatch==='*'&&records.has(key)||c.etagMatches&&c.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));puts++;return {etag:etags.get(key)};}};
}
const ctx=vm.createContext({crypto:webcrypto,TextEncoder,console,Date,JSON,Map,Set,Response,Request,URL});
const F=vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8')+';LetterboxdFacts',ctx);
const workerFetch=env=>async(url,init)=>{const request=new Request(url,init),response=await F.handleBaselineRequest(request,env,new URL(url).pathname);return {ok:response.ok,status:response.status,json:()=>response.json()};};

const scratch=await mkdtemp(path.join(os.tmpdir(),'iptv-lb-baseline-'));
try{
 // Invented export: two films whose codes are stored ids, one unmatched film.
 const csv=(header,rows)=>header+'\n'+rows.map(row=>row.join(',')).join('\n')+'\n';
 const exportFiles={
  'watched.csv':csv('Date,Name,Year,Letterboxd URI',[['2024-05-01','Invented Heist','1995','https://boxd.it/Ab1'],['2024-06-01','Invented Chase','1998','https://boxd.it/Cd2'],['2024-07-01','Nobody Knows This','2001','https://boxd.it/Zz9']]),
  'ratings.csv':csv('Date,Name,Year,Letterboxd URI,Rating',[['2024-05-02','Invented Heist','1995','https://boxd.it/Ab1','4.5']]),
  'watchlist.csv':csv('Date,Name,Year,Letterboxd URI',[['2024-01-01','Invented Chase','1998','https://boxd.it/Cd2']]),
  'diary.csv':csv('Date,Name,Year,Letterboxd URI,Rating,Watched Date',[]),
 };
 const zipPath=path.join(scratch,'letterboxd-demo-user-2026-10-26-13-48-utc.zip');await writeFile(zipPath,zip(exportFiles));
 const snapshotDir=path.join(scratch,'snapshot');await mkdir(path.join(snapshotDir,'objects'),{recursive:true});
 const values={'watchlist.json':{films:[{id:'Ab1',title:'Invented Heist',original:'Invented Heist',year:1995,tmdbId:'949'},{id:'Cd2',title:'Invented Chase',original:'Invented Chase',year:1998}]}},entries=[];
 for(const [key,value] of Object.entries(values)){const bytes=Buffer.from(JSON.stringify(value)),file='objects/'+sha256(Buffer.from(key))+'.bin';await writeFile(path.join(snapshotDir,file),bytes);entries.push({key,file,size:bytes.length,sha256:sha256(bytes)});}
 await writeFile(path.join(snapshotDir,'manifest.json'),JSON.stringify({schemaVersion:1,source:{kind:'cloudflare-r2-s3',bucket:'iptv',readOnly:true},status:'consistent_fenced',noGoReasons:[],fence:{ok:true,keys:[]},changes:[],baselineIdentity:{programmeRunId:'run-test'},objects:entries}));
 const output=path.join(scratch,'out'),now=Date.parse('2026-10-27T00:00:00Z');

 // Plan (offline): only accepted films; private rows stay in plan.jsonl, the report carries counts only.
 const report=await plan({zip:zipPath,snapshot:snapshotDir,output,now});
 assert.deepEqual(report.planned,{films:2,chunks:1,watched:2,rated:1,notRated:1,watchlist:1});assert.equal(report.unresolved,1);assert.equal(report.generatedAtSource,'archive_name');
 const reportText=fs.readFileSync(path.join(output,'report.json'),'utf8');for(const secret of ['Invented','Ab1','Cd2','Zz9','4.5'])assert.ok(!reportText.includes(secret),'report leaks '+secret);
 const origin=JSON.parse(fs.readFileSync(path.join(output,'origin.json'),'utf8'));
 assert.equal(origin.generatedAt,'2026-10-26T13:48:00.000Z');assert.equal(origin.archiveSha256,sha256(fs.readFileSync(zipPath)));assert.equal(origin.files['watched.csv'],sha256(exportFiles['watched.csv']));
 // Archive name and time rules.
 const renamed=path.join(scratch,'export.zip');await writeFile(renamed,zip(exportFiles));
 await assert.rejects(plan({zip:renamed,snapshot:snapshotDir,output:path.join(scratch,'o2'),now}),/--generated-at/);
 assert.equal((await plan({zip:renamed,snapshot:snapshotDir,output:path.join(scratch,'o3'),generatedAt:'2026-10-26T13:48:00Z',now})).generatedAtSource,'owner_declared');
 await assert.rejects(plan({zip:renamed,snapshot:snapshotDir,output:path.join(scratch,'o4'),generatedAt:'2027-01-01T00:00:00Z',now}),/future/);
 await assert.rejects(plan({zip:zipPath,snapshot:snapshotDir,output:path.resolve('tests','private-out'),now}),/outside the Git repository/);
 // Tampering: the archive or the plan must still match origin.json.
 const tamperedDir=path.join(scratch,'tamper');await plan({zip:zipPath,snapshot:snapshotDir,output:tamperedDir,now});
 fs.appendFileSync(path.join(tamperedDir,'plan.jsonl'),'\n');await assert.rejects(loadVerifiedPlan({zip:zipPath,output:tamperedDir,now}),/plan.jsonl differs/);
 const other=path.join(scratch,'letterboxd-demo-user-2026-10-26-13-48-utc-copy');await mkdir(other);const otherZip=path.join(other,'letterboxd-demo-user-2026-10-26-13-48-utc.zip');
 await writeFile(otherZip,zip({...exportFiles,'ratings.csv':exportFiles['ratings.csv'].replace('4.5','3')}));await assert.rejects(loadVerifiedPlan({zip:otherZip,output,now}),/differs from origin.json/);

 // The route is inert until the gate is on.
 const b=bucket(),off={BUCKET:b},on={BUCKET:b,LETTERBOXD_BASELINE_IMPORT:'on'};
 let summary=await remote({mode:'validate',zip:zipPath,output,endpoint:'https://site.example',fetchImpl:workerFetch(off),env:{},now});
 assert.equal(summary.failed.status,409);assert.equal(b.puts,0);
 await assert.rejects(remote({mode:'commit',zip:zipPath,output,endpoint:'http://site.example',fetchImpl:workerFetch(on),env:{},now}),/HTTPS/);
 // Legacy view values exist before the import; validate writes nothing.
 await b.put('enrichment/view-index.json',JSON.stringify({Cd2:{actualRating:3}}));const putsBefore=b.puts;
 summary=await remote({mode:'validate',zip:zipPath,output,endpoint:'https://site.example',fetchImpl:workerFetch(on),env:{},now});
 assert.equal(summary.failed,null);assert.equal(summary.totals.new,5);assert.equal(b.puts,putsBefore,'validate writes nothing');
 // A crash after the intent is recovered by the retry; the intent keeps the pre-import view before-image.
 b.failOnce(key=>key===F.recordKey('lb-Cd2'));
 summary=await remote({mode:'commit',zip:zipPath,output,endpoint:'https://site.example',fetchImpl:workerFetch(on),env:{},now}).catch(error=>({error}));
 assert.ok(summary.error||summary.failed);
 summary=await remote({mode:'commit',zip:zipPath,output,endpoint:'https://site.example',fetchImpl:workerFetch(on),env:{},now});
 assert.equal(summary.failed,null);
 const sha=origin.archiveSha256,receipt=b.records.get('letterboxd/imports/'+sha+'/chunks/0.receipt.json');
 assert.deepEqual(receipt.viewBefore.Cd2,{actualRating:3},'the before-image is the view before the import, not after the retry');
 const heat=b.records.get(F.recordKey('tmdb-949')),chase=b.records.get(F.recordKey('lb-Cd2'));
 assert.equal(heat.rating.value,4.5);assert.equal(heat.rating.source,'letterboxd_export');assert.equal(heat.rating.observedAt,'2026-10-26T13:48:00.000Z');assert.equal(heat.watched.effectiveOn,'2024-05-01');
 assert.equal(chase.rating.value,null);assert.equal(chase.watchlist.value,true);
 const view=b.records.get('enrichment/view-index.json');assert.deepEqual([view.Ab1.actualRating,view.tmdb_949.actualRating,view.Cd2.actualRating,view.Cd2.watched],[4.5,4.5,null,true]);
 // A repeated commit is a replay and writes nothing; the same chunk with other items is refused.
 const putsAfter=b.puts;summary=await remote({mode:'commit',zip:zipPath,output,endpoint:'https://site.example',fetchImpl:workerFetch(on),env:{},now});
 assert.equal(summary.chunksDone,1);assert.equal(b.puts,putsAfter);
 const conflicting=await F.handleBaselineRequest(new Request('https://site.example/api/letterboxd/baseline/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({origin:{archiveSha256:sha,generatedAt:origin.generatedAt,generatedAtSource:'archive_name'},chunk:0,items:[{lid:'Ab1',facts:{watchlist:true}}]})}),on,'/api/letterboxd/baseline/commit');
 assert.equal(conflicting.status,409);
 // Rollback: an owner edit made after the import survives; everything else returns to the before-images.
 await F.recordFilmFacts(on,'Ab1',{rating:2},{observedAt:'2026-10-27T00:00:00.000Z',source:'owner'});
 summary=await remote({mode:'rollback',zip:zipPath,output,endpoint:'https://site.example',fetchImpl:workerFetch(on),env:{},now});
 assert.equal(summary.failed,null);assert.deepEqual(summary.totals,{restored:4,superseded:1});
 assert.equal(b.records.get(F.recordKey('tmdb-949')).rating.value,2);assert.equal(b.records.get(F.recordKey('tmdb-949')).watched,undefined);
 const restored=b.records.get('enrichment/view-index.json');assert.equal(restored.Cd2.actualRating,3,'the legacy view value comes back');assert.equal(restored.Cd2.watched,undefined);assert.equal(restored.Ab1.actualRating,2);
 const again=await remote({mode:'rollback',zip:zipPath,output,endpoint:'https://site.example',fetchImpl:workerFetch(on),env:{},now});assert.equal(again.failed,null);
 // The summary floor: an export older than the latest films-list scan does not override it.
 const b2=bucket(),on2={BUCKET:b2,LETTERBOXD_BASELINE_IMPORT:'on'};
 await F.applyFilmsListScan(on2,{scanId:'s1',observedAt:'2026-10-26T20:00:00.000Z',films:{Ab1:3},total:1},{watchlistFilms:[{id:'Ab1',tmdbId:'949'}]});
 summary=await remote({mode:'commit',zip:zipPath,output,endpoint:'https://site.example',fetchImpl:workerFetch(on2),env:{},now});
 assert.equal(b2.records.get(F.recordKey('tmdb-949')).rating.value,3);assert.ok(summary.totals.older>=2);
 // A film the latest scan saw that has no record yet: the export loses to the floor and the commit still completes.
 const b3=bucket(),on3={BUCKET:b3,LETTERBOXD_BASELINE_IMPORT:'on'};
 await F.applyFilmsListScan(on3,{scanId:'s1',observedAt:'2026-10-26T20:00:00.000Z',films:{Cd2:2},total:1},{watchlistFilms:[]});
 assert.equal(b3.records.has(F.recordKey('lb-Cd2')),false);
 summary=await remote({mode:'commit',zip:zipPath,output,endpoint:'https://site.example',fetchImpl:workerFetch(on3),env:{},now});
 assert.equal(summary.failed,null,JSON.stringify(summary.failed));
 const floored=b3.records.get(F.recordKey('lb-Cd2'));assert.equal(floored.rating,undefined,'the older export rating is not written');assert.equal(floored.watchlist.value,true,'the watchlist fact the scan did not see is imported');
 // Strict request validation.
 const post=body=>F.handleBaselineRequest(new Request('https://site.example/api/letterboxd/baseline/validate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),on,'/api/letterboxd/baseline/validate');
 const good={origin:{archiveSha256:sha,generatedAt:origin.generatedAt,generatedAtSource:'archive_name'},chunk:0,items:[{lid:'Ab1',facts:{watched:true}}]};
 assert.equal((await post(good)).status,200);
 for(const bad of [{...good,origin:{...good.origin,archiveSha256:'x'}},{...good,origin:{...good.origin,generatedAt:'2099-01-01T00:00:00.000Z'}},{...good,items:[{lid:'Ab1',facts:{watched:false}}]},{...good,items:[{lid:'Ab1',facts:{rating:4}}]},{...good,items:[{lid:'Ab1',facts:{watched:true}},{lid:'Ab1',facts:{watched:true}}]},{...good,items:Array.from({length:201},(_,i)=>({lid:'f'+i,facts:{watched:true}}))},{...good,items:[{lid:'Ab1',facts:{watchlist:false}}]}])
  assert.equal((await post(bad)).status,400,JSON.stringify(bad).slice(0,80));
 assert.equal((await F.handleBaselineRequest(new Request('https://site.example/api/letterboxd/baseline/validate',{method:'GET'}),on,'/api/letterboxd/baseline/validate')).status,405);
}finally{await rm(scratch,{recursive:true,force:true});}
console.log('Letterboxd baseline import: ZIP reader and archive name, plan of accepted films, private outputs, origin binding and tamper refusal, gated route, validate without writes, crash-safe idempotent commit, chunk conflict, rollback with superseded owner edit and view before-image, summary floor, strict input passed');
