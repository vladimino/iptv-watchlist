// AIR-222 stage 2: the installer applies a planned split to a bucket through the S3 API. Against a local fake bucket with
// conditional PutObject: the dry run sends no write, the apply writes exactly the plan plus the lease and the Worker then
// reads the active ledger, a rerun writes nothing, a non-planned key and a missing precondition are refused before any
// request, a lost precondition stops the apply, and the CLI gates --apply behind the explicit flag and the write credential.
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {spawn} from 'node:child_process';
import {manifestFor} from '../scripts/migration-export.mjs';
import {loadWorker} from '../scripts/discovery-ledger-offline.mjs';
import {plan} from '../scripts/discovery-ledger-split.mjs';
import {InstallError,createS3Store,preflight,run} from '../scripts/discovery-ledger-install.mjs';

const sha256=value=>createHash('sha256').update(value).digest('hex');
const hmac=(key,value)=>createHmac('sha256',key).update(value).digest();
const ACCOUNT='0123456789abcdef0123456789abcdef',READ_KEY='readkey',READ_SECRET='readsecret',WRITE_KEY='writekey',WRITE_SECRET='writesecret';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-ledger-install-'));

// A fake S3 bucket: SigV4 verified against two credentials, GET/HEAD/LIST for both, PutObject with If-Match / If-None-Match
// (evaluated against the current ETag) only for the write credential.
function fakeBucket(initial){
 const items=new Map();let revision=0;
 const put=(key,bytes)=>{revision++;items.set(key,{bytes:Buffer.from(bytes),etag:sha256(Buffer.from(bytes)).slice(0,32)+'-'+revision,lastModified:new Date(Date.UTC(2026,9,28,0,0,revision)).toUTCString()});return items.get(key);};
 for(const [key,bytes] of Object.entries(initial))put(key,bytes);
 const calls={list:0,head:0,get:0,put:0,precondition:0,badSignature:0,readOnlyWrite:0},puts=[];
 const rfc=value=>encodeURIComponent(value).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
 function verify(request,url,body){
  const match=(request.headers.authorization||'').match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/);
  if(!match)return null;
  const [,access,date,region,service,signedHeaders,signature]=match,secret=access===READ_KEY?READ_SECRET:access===WRITE_KEY?WRITE_SECRET:null;
  if(!secret)return null;
  const names=signedHeaders.split(';'),canonicalPath=url.pathname.split('/').map(s=>rfc(decodeURIComponent(s))).join('/')||'/';
  const query=[...url.searchParams.entries()].map(([n,v])=>[rfc(n),rfc(v)]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:a[1]<b[1]?-1:1).map(p=>p.join('=')).join('&');
  const canonical=[request.method,canonicalPath,query,...names.map(n=>n+':'+String(request.headers[n]??'').trim().replace(/\s+/g,' ')),'',signedHeaders,request.headers['x-amz-content-sha256']].join('\n');
  const stringToSign=['AWS4-HMAC-SHA256',request.headers['x-amz-date'],date+'/'+region+'/'+service+'/aws4_request',sha256(canonical)].join('\n');
  const key=hmac(hmac(hmac(hmac('AWS4'+secret,date),region),service),'aws4_request');
  if(createHmac('sha256',key).update(stringToSign).digest('hex')!==signature||request.headers['x-amz-content-sha256']!==sha256(body))return null;
  return access;
 }
 const server=http.createServer(async(request,response)=>{
  const chunks=[];for await(const chunk of request)chunks.push(chunk);const body=Buffer.concat(chunks);
  const url=new URL(request.url,'http://127.0.0.1'),[,bucketName,...rest]=url.pathname.split('/'),key=rest.length?rest.map(decodeURIComponent).join('/'):null;
  const access=verify(request,url,body);
  if(!access){calls.badSignature++;response.writeHead(403);response.end();return;}
  if(bucketName!=='iptv'){response.writeHead(404);response.end();return;}
  if(request.method==='PUT'){
   if(access!==WRITE_KEY){calls.readOnlyWrite++;response.writeHead(403);response.end('<Error><Code>AccessDenied</Code></Error>');return;}
   calls.put++;const current=items.get(key),ifMatch=request.headers['if-match'],ifNoneMatch=request.headers['if-none-match'];
   if(ifNoneMatch==='*'&&current||ifMatch&&(!current||ifMatch.replace(/^"(.*)"$/,'$1')!==current.etag)){calls.precondition++;response.writeHead(412);response.end();return;}
   const saved=put(key,body);puts.push(key);response.writeHead(200,{ETag:'"'+saved.etag+'"','Content-Length':0});response.end();return;
  }
  if(request.method!=='GET'&&request.method!=='HEAD'){response.writeHead(405);response.end();return;}
  if(key===null){
   calls.list++;const prefix=url.searchParams.get('prefix')||'',keys=[...items.keys()].filter(k=>k.startsWith(prefix)).sort();
   const start=url.searchParams.has('continuation-token')?Number(Buffer.from(url.searchParams.get('continuation-token'),'base64').toString()):0,limit=Math.min(500,Number(url.searchParams.get('max-keys')||1000)),selected=keys.slice(start,start+limit),truncated=start+limit<keys.length;
   const xml='<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>iptv</Name><IsTruncated>'+truncated+'</IsTruncated>'+(truncated?'<NextContinuationToken>'+Buffer.from(String(start+limit)).toString('base64')+'</NextContinuationToken>':'')+selected.map(k=>{const o=items.get(k);return '<Contents><Key>'+k.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</Key><Size>'+o.bytes.length+'</Size><ETag>&quot;'+o.etag+'&quot;</ETag><LastModified>'+o.lastModified+'</LastModified></Contents>';}).join('')+'</ListBucketResult>';
   response.writeHead(200,{'Content-Type':'application/xml','Content-Length':Buffer.byteLength(xml)});response.end(xml);return;
  }
  if(request.method==='HEAD')calls.head++;else calls.get++;
  const object=items.get(key);if(!object){response.writeHead(404);response.end();return;}
  response.writeHead(200,{ETag:'"'+object.etag+'"','Content-Length':object.bytes.length,'Last-Modified':object.lastModified,'Content-Type':'application/json'});
  if(request.method==='HEAD')response.end();else response.end(object.bytes);
 });
 return {items,calls,puts,put,server,async start(){await new Promise(r=>server.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+server.address().port;},async stop(){await new Promise(r=>server.close(r));}};
}

// A synthetic full-mode ledger of ten daily scans (the same shape as tests/discovery-ledger-split.mjs).
const context=loadWorker(),merge=vm.runInContext('mergeDiscoveryCandidates',context);
const DAY=86400000,BASE=Date.UTC(2026,9,20,12),runId=day=>'00000000-0000-4000-8000-'+String(day).padStart(12,'0');
const titles=['Брат','Сталкер','Солярис','Зеркало','Кин-дза-дза','Ирония судьбы'],airs=(i,d)=>i<40?true:i<120?(d+i)%3!==0:i<180?(i+d)%5===0:d===i%10;
function scan(day){const out=[];for(let i=0;i<260;i++){if(!airs(i,day))continue;const start=BASE+day*DAY+(i%12)*3600000,title=titles[i%6]+' '+i+' ('+(1960+i%40)+')';out.push({key:null,confirmedTmdbId:null,title,rawTitles:[title],normalizedTitle:null,year:1960+i%40,duration:90,description:'Описание '+i,firstAiring:start,lastAiring:start,airings:1,shows:[{channelId:'ch'+(i%7),channel:'Канал '+(i%7),start,end:start+5400000,epgTitle:title}]});}return out;}
let ledgerItems=[];for(let day=0;day<10;day++)ledgerItems=merge(ledgerItems,scan(day),{replaceShows:true,programmeRunId:runId(day)});
const P=runId(9),ledger={programmeRunId:P,updatedAt:new Date(BASE+9*DAY).toISOString(),items:ledgerItems};
const bodies={'epg/published-generation.json':{programmeRunId:P,phase:'published'},'epg/discovery-latest.json':ledger,['epg/generations/'+P+'/discovery-latest.json']:ledger,['epg/generations/'+P+'/programme.json']:{runId:P,films:[]},'programme.json':{runId:P,films:[]},'epg/discovered-films.json':{},'epg/discovery-resolution.json':{},'sync.json':{runId:P,stage:'complete'},'epg/resolver-lease.json':{id:'old',expiresAt:0}};
// The snapshot the plan is made from: the same bytes and ETags the fake bucket serves.
function writeSnapshot(bucket){
 const directory=path.join(root,'snapshot');fs.mkdirSync(path.join(directory,'objects'),{recursive:true});
 const entries=[...bucket.items].map(([key,o])=>{const file=sha256(Buffer.from(key,'utf8'))+'.bin';fs.writeFileSync(path.join(directory,'objects',file),o.bytes);return {key,file:'objects/'+file,size:o.bytes.length,sha256:sha256(o.bytes),metadata:{key,size:o.bytes.length,etag:'"'+o.etag+'"'}};});
 const manifest={...manifestFor(entries,1,'2026-10-28T08:00:00.000Z','2026-10-28T08:10:00.000Z',[]),sourceSiteId:null,sourceOrigin:null,status:'consistent_fenced',noGoReasons:[],source:{kind:'cloudflare-r2-s3',bucket:'iptv',accountId:ACCOUNT,endpoint:'example.r2',endpointOverride:true,exporter:'scripts/r2-snapshot-export.mjs',readOnly:true},fence:{ok:true,keys:[]},baselineIdentity:{publishedProgrammeRunId:P}};
 fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest));return directory;
}
const envFor=(endpoint,write=false)=>({R2_SNAPSHOT_ACCOUNT_ID:ACCOUNT,R2_SNAPSHOT_ACCESS_KEY_ID:READ_KEY,R2_SNAPSHOT_SECRET_ACCESS_KEY:READ_SECRET,R2_SNAPSHOT_BUCKET:'iptv',R2_SNAPSHOT_ENDPOINT:endpoint,...(write?{R2_INSTALL_ACCESS_KEY_ID:WRITE_KEY,R2_INSTALL_SECRET_ACCESS_KEY:WRITE_SECRET}:{})});
const out=name=>{const d=path.join(root,'out-'+name);fs.rmSync(d,{recursive:true,force:true});return d;};
const SCRIPT=path.resolve('scripts/discovery-ledger-install.mjs');
// The fake bucket lives in this process, so the CLI is spawned asynchronously (a spawnSync would block the server).
const cliRun=(args,env)=>new Promise(resolve=>{const child=spawn(process.execPath,[SCRIPT,...args],{env:{...process.env,...env}});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('close',status=>resolve({status,stdout,stderr}));});

try{
 const bucket=fakeBucket(Object.fromEntries(Object.entries(bodies).map(([k,v])=>[k,JSON.stringify(v)])));const endpoint=await bucket.start();
 const snapshot=writeSnapshot(bucket),planDir=out('plan');
 const planned=await plan({snapshot,output:planDir});assert.equal(planned.report.verdict,'READY');
 const seen=planned.report.active.items;assert.ok(seen>0&&planned.report.archived.items>0);

 // Dry run: read-only credential, no write, READY.
 const dry=await run({plan:planDir,output:out('dry'),env:envFor(endpoint)});
 assert.equal(dry.verdict,'READY');assert.equal(dry.preflight.wouldWrite,planned.plan.writes.length);assert.deepEqual(dry.preflight.conflicts,[]);
 assert.equal(bucket.calls.put,0);assert.equal(dry.calls.put,0);
 // --apply without the flag, and without the write credential, never reaches the bucket.
 await assert.rejects(run({plan:planDir,output:out('noflag'),apply:true,env:envFor(endpoint)}),e=>e instanceof InstallError&&e.exitCode===2);
 await assert.rejects(run({plan:planDir,output:out('nocred'),apply:true,approved:true,env:envFor(endpoint)}),e=>e instanceof InstallError&&e.exitCode===2);
 assert.equal(bucket.calls.put,0);
 // The store refuses a non-planned key and a write without precondition before any request.
 const guarded=createS3Store({credentials:{accountId:ACCOUNT,accessKeyId:WRITE_KEY,secretAccessKey:WRITE_SECRET,bucket:'iptv',endpoint},allowedWrites:new Set(['a'])});
 await assert.rejects(guarded.put('b','{}',{onlyIf:{etagDoesNotMatch:'*'}}),e=>e.exitCode===3);
 await assert.rejects(guarded.put('a','{}',{}),e=>e.exitCode===3);
 await assert.rejects(guarded.delete('a'),e=>e.exitCode===3);
 assert.equal(bucket.calls.put,0);
 // A read-only credential cannot write even through the allowlist (the bucket answers 403).
 const readOnlyStore=createS3Store({credentials:{accountId:ACCOUNT,accessKeyId:READ_KEY,secretAccessKey:READ_SECRET,bucket:'iptv',endpoint},allowedWrites:new Set(['probe'])});
 await assert.rejects(readOnlyStore.put('probe','{}',{onlyIf:{etagDoesNotMatch:'*'}}),e=>e.exitCode===3);assert.equal(bucket.calls.readOnlyWrite,1);

 // Apply: exactly the plan's keys plus the lease, in plan order; the Worker reads the active ledger afterwards.
 const applyDir=out('apply'),applied=await run({plan:planDir,output:applyDir,apply:true,approved:true,env:envFor(endpoint,true)});
 assert.equal(applied.verdict,'INSTALLED',JSON.stringify(applied));
 assert.equal(applied.applied.applied,planned.plan.writes.length);
 const plannedKeys=planned.plan.writes.map(w=>w.key);
 assert.deepEqual(bucket.puts.filter(k=>k!=='epg/resolver-lease.json'),plannedKeys,'planned keys in plan order');
 assert.ok(bucket.puts.filter(k=>k==='epg/resolver-lease.json').length>=2,'the lease is acquired and released');
 assert.equal(applied.postCheck.workerReadsActive,true);assert.equal(applied.postCheck.activeItems,seen);assert.equal(applied.postCheck.rootSha256Matches,true);assert.equal(applied.postCheck.archivePointer,true);
 const receipts=JSON.parse(fs.readFileSync(path.join(applyDir,'receipts.json'),'utf8'));
 assert.equal(receipts.length,plannedKeys.length+bucket.puts.filter(k=>k==='epg/resolver-lease.json').length);
 for(const receipt of receipts.filter(r=>plannedKeys.includes(r.key)))assert.equal(receipt.sha256,planned.plan.writes.find(w=>w.key===receipt.key).sha256);
 const active=JSON.parse(bucket.items.get('epg/generations/'+P+'/discovery-latest.json').bytes.toString());assert.equal(active.ledgerMode,'bounded');assert.equal(active.items.length,seen);
 assert.deepEqual(JSON.parse(bucket.items.get('epg/discovery-archive/v1/sources/'+planned.plan.manifestId+'/discovery-latest.json').bytes.toString()).items.length,ledgerItems.length,'the source copy holds the full ledger');

 // Rerun: everything is done, nothing but the lease is written.
 const putsBefore=bucket.puts.length;
 const again=await run({plan:planDir,output:out('again'),apply:true,approved:true,env:envFor(endpoint,true)});
 assert.equal(again.verdict,'INSTALLED');assert.equal(again.applied.applied,0);
 assert.deepEqual(bucket.puts.slice(putsBefore).filter(k=>k!=='epg/resolver-lease.json'),[]);
 // Dry run after the install reports done, not ready.
 const after=await run({plan:planDir,output:out('after'),env:envFor(endpoint)});
 assert.equal(after.verdict,'ALREADY-INSTALLED');assert.equal(after.preflight.states.done,plannedKeys.length);assert.equal(after.preflight.wouldWrite,0);assert.equal(after.preflight.fence.archivePointerAbsent,false);

 // A lost precondition stops the apply: a fresh bucket whose published pointer moved after the plan.
 const bucket2=fakeBucket(Object.fromEntries(Object.entries(bodies).map(([k,v])=>[k,JSON.stringify(v)])));const endpoint2=await bucket2.start();
 bucket2.put('epg/published-generation.json',JSON.stringify({programmeRunId:runId(10),phase:'published'}));
 const moved=await run({plan:planDir,output:out('moved'),apply:true,approved:true,env:envFor(endpoint2,true)});
 assert.equal(moved.verdict,'NOT-READY');assert.equal(moved.preflight.fence.pointerEtagMatches,false);assert.equal(bucket2.calls.put,0);
 // A 412 during the apply (a concurrent writer replaced the generation copy between the state check and the CAS) is a stop
 // with receipts for what was written; neither ledger copy is replaced and the archive pointer already exists.
 const bucket3=fakeBucket(Object.fromEntries(Object.entries(bodies).map(([k,v])=>[k,JSON.stringify(v)])));const endpoint3=await bucket3.start();
 const original3=bucket3.server.listeners('request')[0];
 let armed=true;bucket3.server.removeAllListeners('request');bucket3.server.on('request',(request,response)=>{if(armed&&request.method==='PUT'&&request.url.includes('generations')&&request.url.includes('discovery-latest')){armed=false;bucket3.put('epg/generations/'+P+'/discovery-latest.json',JSON.stringify({...ledger,updatedAt:'moved'}));}original3(request,response);});
 const raceDir=out('race');await assert.rejects(run({plan:planDir,output:raceDir,apply:true,approved:true,env:envFor(endpoint3,true)}),e=>e instanceof InstallError&&e.exitCode===3);
 const raceReport=JSON.parse(fs.readFileSync(path.join(raceDir,'install-report.json'),'utf8'));
 assert.equal(raceReport.verdict,'STOPPED');assert.match(raceReport.error,/Conditional write lost/);assert.equal(bucket3.calls.precondition,1,'the bucket answered 412 once');
 for(const key of ['epg/generations/'+P+'/discovery-latest.json','epg/discovery-latest.json'])assert.ok(!bucket3.items.get(key).bytes.toString().includes('"ledgerMode":"bounded"'),'no ledger copy was replaced');
 assert.ok(bucket3.items.has('epg/discovery-archive/v1/current.json'),'the archive pointer exists: readers see full ledger plus archive, losslessly');

 // CLI: the dry run exits 0 with aggregates only; --apply without the flag exits 2; output inside the repository exits 2.
 const cli=await cliRun(['--plan',planDir,'--output',out('cli')],envFor(endpoint));
 assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).verdict,'ALREADY-INSTALLED','the first bucket is already installed');
 const cli2=await cliRun(['--plan',planDir,'--output',out('cli2'),'--apply'],envFor(endpoint,true));
 assert.equal(cli2.status,2);assert.match(cli2.stderr,/approved-production-writes/);
 const cli3=await cliRun(['--plan',planDir,'--output',path.join(process.cwd(),'tmp-install')],envFor(endpoint));
 assert.equal(cli3.status,2);
 for(const text of [cli.stdout,JSON.stringify(applied),JSON.stringify(dry)])for(const item of ledgerItems.slice(0,20))assert.ok(!text.includes(item.key)&&!text.includes(item.title),'no key or title in reports');
 await bucket.stop();await bucket2.stop();await bucket3.stop();
 await bucket.stop();await bucket2.stop();await bucket3.stop();
 console.log('discovery ledger install: ok');
}finally{fs.rmSync(root,{recursive:true,force:true});}
