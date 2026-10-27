import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,webcrypto} from 'node:crypto';
import fs from 'node:fs';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {crc32} from '../src/letterboxd-zip.js';
import {DEFAULT_CHUNK_SIZE,LEGACY_CHUNK_SIZE,MAX_CHUNK_SIZE,loadVerifiedPlan,plan,remote} from '../scripts/letterboxd-baseline-import.mjs';

// Chunking of the baseline import: bounded plan chunk sizes, the legacy 200-film plans, client-side network failures and
// resume from the Worker's intents. Invented films only, an in-memory bucket and the Worker module in a context of its own.
const sha256=value=>createHash('sha256').update(value).digest('hex');
function zip(files){
 const locals=[],centrals=[];let offset=0;
 for(const [name,text] of Object.entries(files)){
  const data=Buffer.from(text),nameBytes=Buffer.from(name),crc=crc32(data);
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(nameBytes.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(nameBytes.length,28);central.writeUInt32LE(offset,42);
  locals.push(local,nameBytes,data);centrals.push(central,nameBytes);offset+=30+nameBytes.length+data.length;
 }
 const directory=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,directory,end]);
}
// A CAS bucket whose puts can be made to fail while a predicate holds (a Worker cut off mid-chunk).
function bucket(){
 const records=new Map(),etags=new Map();let revision=0,puts=0,fail=null;
 return {records,get puts(){return puts;},failWhile(predicate){fail=predicate;},
  async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
  async put(key,value,options={}){if(fail&&fail(key))throw new Error('injected failure');const c=options.onlyIf||{};if(c.etagDoesNotMatch==='*'&&records.has(key)||c.etagMatches&&c.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));puts++;return {etag:etags.get(key)};}};
}
const ctx=vm.createContext({crypto:webcrypto,TextEncoder,console,Date,JSON,Map,Set,Response,Request,URL});
const F=vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8')+';LetterboxdFacts',ctx);
const handle=(env,url,init)=>F.handleBaselineRequest(new Request(url,init),env,new URL(url).pathname);
const workerFetch=(env,seen=[])=>async(url,init)=>{const body=JSON.parse(init.body);seen.push(body.chunk);const response=await handle(env,url,init);return {ok:response.ok,status:response.status,json:()=>response.json()};};
const gates=b=>({BUCKET:b,LETTERBOXD_BASELINE_IMPORT:'on',LETTERBOXD_FACTS:'on'});
const endpoint='https://site.example',now=Date.parse('2026-10-27T00:00:00Z');

const scratch=await mkdtemp(path.join(os.tmpdir(),'iptv-lb-chunks-'));
try{
 // n invented films, all watched, every third rated and every fourth on the watchlist; ids equal codes and the stored title
 // and year corroborate them, so every film is accepted.
 const lid=i=>'F'+String(i).padStart(4,'0');
 async function fixture(n){
  const dir=path.join(scratch,'fixture-'+n);await mkdir(path.join(dir,'snapshot','objects'),{recursive:true});
  const csv=(header,rows)=>header+'\n'+rows.map(row=>row.join(',')).join('\n')+'\n',films=Array.from({length:n},(_,i)=>i);
  const files={
   'watched.csv':csv('Date,Name,Year,Letterboxd URI',films.map(i=>['2024-05-01','Invented Film '+i,'2000','https://boxd.it/'+lid(i)])),
   'ratings.csv':csv('Date,Name,Year,Letterboxd URI,Rating',films.filter(i=>i%3===0).map(i=>['2024-05-02','Invented Film '+i,'2000','https://boxd.it/'+lid(i),String(1+i%5)])),
   'watchlist.csv':csv('Date,Name,Year,Letterboxd URI',films.filter(i=>i%4===0).map(i=>['2024-01-01','Invented Film '+i,'2000','https://boxd.it/'+lid(i)])),
   'diary.csv':csv('Date,Name,Year,Letterboxd URI,Rating,Watched Date',[]),
  };
  const zipPath=path.join(dir,'letterboxd-demo-user-2026-10-26-13-48-utc.zip');await writeFile(zipPath,zip(files));
  const watchlist={films:films.map(i=>({id:lid(i),title:'Invented Film '+i,original:'Invented Film '+i,year:2000}))},bytes=Buffer.from(JSON.stringify(watchlist)),file='objects/'+sha256(Buffer.from('watchlist.json'))+'.bin';
  await writeFile(path.join(dir,'snapshot',file),bytes);
  await writeFile(path.join(dir,'snapshot','manifest.json'),JSON.stringify({schemaVersion:1,source:{kind:'cloudflare-r2-s3',bucket:'iptv',readOnly:true},status:'consistent_fenced',noGoReasons:[],fence:{ok:true,keys:[]},changes:[],baselineIdentity:{programmeRunId:'run-test'},objects:[{key:'watchlist.json',file,size:bytes.length,sha256:sha256(bytes)}]}));
  return {zip:zipPath,snapshot:path.join(dir,'snapshot')};
 }
 const out=name=>path.join(scratch,'out-'+name);
 const chunkSizes=async output=>(await loadVerifiedPlan({zip:fx.zip,output,now})).chunks.map(items=>items.length);
 let fx;

 // Chunk size: the default and the bound; the remote steps take the size from origin.json only.
 assert.ok(DEFAULT_CHUNK_SIZE<=MAX_CHUNK_SIZE&&MAX_CHUNK_SIZE<LEGACY_CHUNK_SIZE);
 fx=await fixture(7);
 for(const bad of [0,MAX_CHUNK_SIZE+1,LEGACY_CHUNK_SIZE,1.5,'3'])await assert.rejects(plan({...fx,output:out('bad'),chunkSize:bad,now}),/--chunk-size must be an integer 1\.\.100/);
 assert.equal(fs.existsSync(out('bad')),false,'a refused plan writes nothing');
 const cli=args=>spawnSync(process.execPath,['scripts/letterboxd-baseline-import.mjs',...args],{encoding:'utf8'});
 let run=cli(['commit','--zip',fx.zip,'--output',out('cli'),'--endpoint',endpoint,'--chunk-size','10']);
 assert.equal(run.status,2);assert.match(run.stderr,/--chunk-size is a plan option/);
 run=cli(['plan','--zip',fx.zip,'--snapshot',fx.snapshot,'--output',out('cli'),'--chunk-size','101']);
 assert.equal(run.status,2);assert.match(run.stderr,/1\.\.100/);
 run=cli(['plan','--zip',fx.zip,'--snapshot',fx.snapshot,'--output',out('cli'),'--chunk-size','3']);
 assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).chunkSize,3);assert.equal(JSON.parse(run.stdout).planned.chunks,3);

 // Boundaries: N = k·size, k·size − 1 and k·size + 1 films; order and identity of the films survive chunking.
 for(const [n,expected] of [[6,[3,3]],[5,[3,2]],[7,[3,3,1]]]){
  fx=await fixture(n);const output=out('boundary-'+n);
  const report=await plan({...fx,output,chunkSize:3,now});assert.equal(report.planned.chunks,expected.length);assert.equal(report.chunkSize,3);
  const origin=JSON.parse(fs.readFileSync(path.join(output,'origin.json'),'utf8'));assert.deepEqual([origin.schemaVersion,origin.chunkSize,origin.chunks],[2,3,expected.length]);
  assert.deepEqual(await chunkSizes(output),expected,'chunk sizes for '+n);
  assert.deepEqual((await loadVerifiedPlan({zip:fx.zip,output,now})).chunks.flat().map(item=>item.lid),Array.from({length:n},(_,i)=>lid(i)),'one sorted order across chunks');
 }
 // The default size: 2·50 and 2·50 + 1 films.
 for(const [n,expected] of [[100,[50,50]],[101,[50,50,1]]]){fx=await fixture(n);await plan({...fx,output:out('default-'+n),now});assert.deepEqual(await chunkSizes(out('default-'+n)),expected);}
 // A plan is deterministic: the same archive, snapshot and size give the same plan; another size in the same directory is refused.
 fx=await fixture(7);
 await plan({...fx,output:out('again'),chunkSize:3,now});const firstPlan=fs.readFileSync(path.join(out('again'),'plan.jsonl'),'utf8');
 await plan({...fx,output:out('again'),chunkSize:3,now});assert.equal(fs.readFileSync(path.join(out('again'),'plan.jsonl'),'utf8'),firstPlan);
 await assert.rejects(plan({...fx,output:out('again'),chunkSize:4,now}),/another archive or chunk size/);
 await assert.rejects(plan({...(await fixture(6)),output:out('again'),chunkSize:3,now}),/another archive or chunk size/);
 assert.equal(fs.readFileSync(path.join(out('again'),'plan.jsonl'),'utf8'),firstPlan,'the refused re-plan left the plan alone');

 // One plan never mixes sizes: lines moved to other chunks (with a matching plan hash) or a forged size are refused.
 {
  const output=out('mixed');await plan({...fx,output,chunkSize:3,now});
  const originPath=path.join(output,'origin.json'),planPath=path.join(output,'plan.jsonl'),origin=JSON.parse(fs.readFileSync(originPath,'utf8'));
  const rewrite=(lines,changes)=>{const text=lines.map(line=>JSON.stringify(line)).join('\n')+'\n';fs.writeFileSync(planPath,text);fs.writeFileSync(originPath,JSON.stringify({...origin,planSha256:sha256(text),...changes}));};
  const lines=fs.readFileSync(planPath,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
  rewrite(lines.map((line,i)=>({...line,chunk:i<4?0:1})),{chunks:2});await assert.rejects(loadVerifiedPlan({zip:fx.zip,output,now}),/chunking differs/);
  rewrite(lines,{chunks:2});await assert.rejects(loadVerifiedPlan({zip:fx.zip,output,now}),/chunk count differs/);
  rewrite(lines,{chunkSize:LEGACY_CHUNK_SIZE});await assert.rejects(loadVerifiedPlan({zip:fx.zip,output,now}),/unknown schema or chunk size/);
  rewrite(lines,{schemaVersion:1});await assert.rejects(loadVerifiedPlan({zip:fx.zip,output,now}),/unknown schema or chunk size/);
  rewrite(lines,{});assert.deepEqual(await chunkSizes(output),[3,3,1]);
 }

 // Network failures: a dropped connection and a client timeout stop the run at that chunk, write the result file with the
 // completed chunks and the failure, and never print or store the error message.
 const facts=n=>{let total=0;for(let i=0;i<n;i++)total+=1+1+(i%4===0?1:0);return total;};// watched + rating/not rated + watchlist
 {
  const output=out('network');await plan({...fx,output,chunkSize:3,now});
  const b=bucket(),env=gates(b),seen=[];
  const dropping=async(url,init)=>{const body=JSON.parse(init.body);if(body.chunk===1)throw new TypeError('fetch failed https://site.example secret',{cause:{code:'ECONNRESET'}});return workerFetch(env,seen)(url,init);};
  const summary=await remote({mode:'commit',zip:fx.zip,output,endpoint,fetchImpl:dropping,env:{},now});
  assert.deepEqual(summary.failed,{chunk:1,status:null,error:'network_error',cause:'ECONNRESET'});
  assert.deepEqual([summary.chunksRequested,summary.chunksDone,summary.chunkSize],[3,1,3]);assert.deepEqual(seen,[0],'stops at the first failure');
  const written=fs.readFileSync(path.join(output,'commit.json'),'utf8');assert.ok(!written.includes('secret')&&!written.includes('site.example'));
  assert.equal(JSON.parse(written).results.length,2);
  // An answer that cannot be read is a failure too, not a crash.
  const unreadable=async()=>({ok:true,status:200,json:async()=>{throw new SyntaxError('Unexpected end of JSON input');}});
  const broken=await remote({mode:'validate',zip:fx.zip,output,endpoint,fetchImpl:unreadable,env:{},now});
  assert.deepEqual(broken.failed,{chunk:0,status:200,error:'response_unreadable',cause:'SyntaxError'});
  // The CLI reports the failure as a summary with exit 1 instead of an uncaught error.
  run=cli(['validate','--zip',fx.zip,'--output',output,'--endpoint','http://127.0.0.1:9']);
  assert.equal(run.status,1,run.stderr);assert.equal(JSON.parse(run.stdout).failed.error,'network_error');assert.equal(run.stderr,'');
 }

 // A client timeout while the Worker is cut off part-way through a chunk: the rerun completes the chunk from its intent,
 // the next rerun is a replay of every chunk, and the facts are exactly the plan's.
 {
  fx=await fixture(7);const output=out('timeout');await plan({...fx,output,chunkSize:3,now});
  const b=bucket(),env=gates(b),sha=JSON.parse(fs.readFileSync(path.join(output,'origin.json'),'utf8')).archiveSha256;
  const intent=chunk=>b.records.has('letterboxd/imports/'+sha+'/chunks/'+chunk+'.intent.json'),receipt=chunk=>b.records.get('letterboxd/imports/'+sha+'/chunks/'+chunk+'.receipt.json');
  let armed=true;
  const timingOut=async(url,init)=>{
   const body=JSON.parse(init.body);
   if(armed&&body.chunk===1){armed=false;const start=b.puts;b.failWhile(()=>b.puts-start>=3);await handle(env,url,init).catch(()=>{});b.failWhile(null);throw new DOMException('The operation was aborted due to timeout','TimeoutError');}
   return workerFetch(env)(url,init);
  };
  let summary=await remote({mode:'commit',zip:fx.zip,output,endpoint,fetchImpl:timingOut,env:{},now});
  assert.deepEqual(summary.failed,{chunk:1,status:null,error:'network_error',cause:'TimeoutError'});assert.equal(summary.chunksDone,1);
  assert.ok(intent(1)&&!receipt(1),'chunk 1 is opened, not committed');assert.equal(intent(2),false,'chunk 2 was never sent');
  const partial=b.records.get(F.recordKey('lb-'+lid(3)));assert.ok(partial?.watched,'part of chunk 1 was written before the cut');
  summary=await remote({mode:'commit',zip:fx.zip,output,endpoint,fetchImpl:workerFetch(env),env:{},now});
  assert.equal(summary.failed,null);assert.equal(summary.chunksDone,3);
  const results=JSON.parse(fs.readFileSync(path.join(output,'commit.json'),'utf8')).results;assert.deepEqual(results.map(result=>result.replay),[true,false,false]);
  assert.deepEqual([0,1,2].map(chunk=>receipt(chunk).films),[3,3,1]);
  for(let i=0;i<7;i++){const record=b.records.get(F.recordKey('lb-'+lid(i)));assert.equal(record.watched.value,true);assert.equal(record.rating.value,i%3===0?1+i%5:null);assert.equal(record.watchlist?.value,i%4===0?true:undefined);}
  // Reruns: every chunk is a replay and nothing is written; validate now reports every fact unchanged.
  const putsBefore=b.puts;summary=await remote({mode:'commit',zip:fx.zip,output,endpoint,fetchImpl:workerFetch(env),env:{},now});
  assert.equal(b.puts,putsBefore);assert.ok(JSON.parse(fs.readFileSync(path.join(output,'commit.json'),'utf8')).results.every(result=>result.replay));
  summary=await remote({mode:'validate',zip:fx.zip,output,endpoint,fetchImpl:workerFetch(env),env:{},now});
  assert.deepEqual(summary.totals,{unchanged:facts(7)});assert.equal(b.puts,putsBefore);
  // The same items under another chunk number would be another chunk; a duplicate film inside one request is refused.
  const origin=JSON.parse(fs.readFileSync(path.join(output,'origin.json'),'utf8')),originBody={archiveSha256:sha,generatedAt:origin.generatedAt,generatedAtSource:origin.generatedAtSource};
  const duplicate=await handle(env,endpoint+'/api/letterboxd/baseline/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({origin:originBody,chunk:0,items:[{lid:lid(0),facts:{watched:true}},{lid:lid(0),facts:{watched:true}}]})});
  assert.equal(duplicate.status,400);
  // --from-chunk/--to-chunk bound a run; rollback walks the chunks in reverse and resumes after a dropped connection.
  const seen=[];summary=await remote({mode:'validate',zip:fx.zip,output,endpoint,fetchImpl:workerFetch(env,seen),env:{},now,fromChunk:1,toChunk:1});
  assert.deepEqual(seen,[1]);assert.equal(summary.chunksRequested,1);
  const rollbackSeen=[];let drop=true;
  const droppingRollback=async(url,init)=>{if(drop&&JSON.parse(init.body).chunk===1){drop=false;throw new TypeError('fetch failed',{cause:{code:'UND_ERR_SOCKET'}});}return workerFetch(env,rollbackSeen)(url,init);};
  summary=await remote({mode:'rollback',zip:fx.zip,output,endpoint,fetchImpl:droppingRollback,env:{},now});
  assert.equal(summary.failed.chunk,1);assert.deepEqual(rollbackSeen,[2]);
  summary=await remote({mode:'rollback',zip:fx.zip,output,endpoint,fetchImpl:workerFetch(env,rollbackSeen),env:{},now});
  assert.equal(summary.failed,null);assert.deepEqual(rollbackSeen,[2,2,1,0]);assert.deepEqual(summary.totals,{restored:facts(7),superseded:0});
  for(let i=0;i<7;i++){const record=b.records.get(F.recordKey('lb-'+lid(i)));assert.equal(record?.watched,undefined,'rolled back '+i);}
 }

 // A legacy plan (schema 1, no chunkSize, chunks of 200) as the earlier tool wrote it still validates, commits, replays and
 // rolls back with its own chunking. A new plan of the same archive with another size is refused: in the legacy plan's
 // directory by the tool, in a fresh directory by the Worker (chunk_conflict), so the old receipts stay unambiguous.
 {
  fx=await fixture(401);const output=out('legacy');await plan({...fx,output,now});
  const originPath=path.join(output,'origin.json'),planPath=path.join(output,'plan.jsonl'),origin=JSON.parse(fs.readFileSync(originPath,'utf8'));
  const text=fs.readFileSync(planPath,'utf8').split('\n').filter(Boolean).map((line,i)=>JSON.stringify({chunk:Math.floor(i/LEGACY_CHUNK_SIZE),item:JSON.parse(line).item})).join('\n')+'\n';
  const {chunkSize,...legacy}=origin;assert.equal(chunkSize,DEFAULT_CHUNK_SIZE);
  fs.writeFileSync(planPath,text);fs.writeFileSync(originPath,JSON.stringify({...legacy,schemaVersion:1,planSha256:sha256(text),chunks:3},null,1)+'\n');
  assert.deepEqual(await chunkSizes(output),[200,200,1]);
  const b=bucket(),env=gates(b),seen=[];
  let summary=await remote({mode:'validate',zip:fx.zip,output,endpoint,fetchImpl:workerFetch(env),env:{},now});
  assert.equal(summary.failed,null);assert.equal(summary.chunkSize,LEGACY_CHUNK_SIZE);assert.equal(summary.totals.new,facts(401));
  summary=await remote({mode:'commit',zip:fx.zip,output,endpoint,fetchImpl:workerFetch(env,seen),env:{},now});
  assert.equal(summary.failed,null);assert.deepEqual(seen,[0,1,2]);
  const putsBefore=b.puts;summary=await remote({mode:'commit',zip:fx.zip,output,endpoint,fetchImpl:workerFetch(env),env:{},now});
  assert.equal(b.puts,putsBefore,'a legacy rerun is a replay');
  await assert.rejects(plan({...fx,output,now}),/another archive or chunk size/);
  const fresh=out('legacy-resized');await plan({...fx,output:fresh,now});
  summary=await remote({mode:'commit',zip:fx.zip,output:fresh,endpoint,fetchImpl:workerFetch(env),env:{},now});
  assert.deepEqual([summary.failed.chunk,summary.failed.status,summary.failed.error],[0,409,'chunk_conflict']);assert.equal(b.puts,putsBefore);
  summary=await remote({mode:'rollback',zip:fx.zip,output,endpoint,fetchImpl:workerFetch(env),env:{},now});
  assert.equal(summary.failed,null);assert.deepEqual(summary.totals,{restored:facts(401),superseded:0});
 }
}finally{await rm(scratch,{recursive:true,force:true});}
console.log('Letterboxd baseline chunks: bounded plan chunk size, CLI size rules, chunk boundaries, one size per plan and directory, network error and unreadable answer reported without a crash, timeout mid-chunk resumed from the intent, replay and unchanged reruns, bounded runs, resumable reverse rollback, legacy 200-film plans kept and not mixed passed');
