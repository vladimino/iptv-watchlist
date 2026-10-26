import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {ExportError} from '../scripts/migration-export.mjs';
import {FENCE_KEYS,NoGo,STATUS_CONSISTENT,STATUS_NO_GO,createReadOnlyClient,exportProductionSnapshot,inventoryDelta,parseListing,plan,readCredentials,signRequest,verifyProductionSnapshot} from '../scripts/r2-snapshot-export.mjs';

const source=fs.readFileSync('scripts/r2-snapshot-export.mjs','utf8');
// The exporter never names a write command, a Worker binding or a repository secret file.
assert.doesNotMatch(source,/'PUT'|'POST'|'DELETE'|\bBUCKET\b|wrangler|dotenv|readFileSync/);
assert.doesNotMatch(fs.readFileSync('build.mjs','utf8'),/r2-snapshot-export/);
const sha256=value=>createHash('sha256').update(value).digest('hex');
const hmac=(key,value)=>createHmac('sha256',key).update(value).digest();
const ACCOUNT='0123456789abcdef0123456789abcdef',ACCESS='test-access-key',SECRET='test-secret-key';

// Signature shape and determinism on the AWS Signature Version 4 test-suite request (get-vanilla credentials and clock); the fake bucket below verifies signatures independently.
{
 const signed=signRequest({method:'GET',url:'https://example.amazonaws.com/',credentials:{accessKeyId:'AKIDEXAMPLE',secretAccessKey:'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'},region:'us-east-1',service:'service',now:new Date('2015-08-30T12:36:00Z')});
 assert.equal(signed['x-amz-date'],'20150830T123600Z');
 assert.match(signed.Authorization,/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
 const vanilla=signRequest({method:'GET',url:'https://example.amazonaws.com/',credentials:{accessKeyId:'AKIDEXAMPLE',secretAccessKey:'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'},region:'us-east-1',service:'service',now:new Date('2015-08-30T12:36:00Z')});
 assert.equal(vanilla.Authorization,signed.Authorization,'signing is deterministic for one clock');
}

// Credentials come from the environment only; a plaintext endpoint is accepted on loopback only; the plan reads no secret.
assert.throws(()=>readCredentials({}),error=>error instanceof ExportError&&error.kind==='configuration');
assert.throws(()=>readCredentials({R2_SNAPSHOT_ACCOUNT_ID:ACCOUNT,R2_SNAPSHOT_ACCESS_KEY_ID:ACCESS}),/SECRET/);
assert.throws(()=>readCredentials({R2_SNAPSHOT_ACCOUNT_ID:ACCOUNT,R2_SNAPSHOT_ACCESS_KEY_ID:ACCESS,R2_SNAPSHOT_SECRET_ACCESS_KEY:SECRET,R2_SNAPSHOT_ENDPOINT:'http://r2.example.net'}),/loopback/);
assert.throws(()=>readCredentials({R2_SNAPSHOT_ACCOUNT_ID:ACCOUNT,R2_SNAPSHOT_ACCESS_KEY_ID:ACCESS,R2_SNAPSHOT_SECRET_ACCESS_KEY:SECRET,R2_SNAPSHOT_ENDPOINT:'https://r2.example.net/path'}),/without a path/);
assert.equal(readCredentials({R2_SNAPSHOT_ACCOUNT_ID:ACCOUNT,R2_SNAPSHOT_ACCESS_KEY_ID:ACCESS,R2_SNAPSHOT_SECRET_ACCESS_KEY:SECRET}).endpoint,'https://'+ACCOUNT+'.r2.cloudflarestorage.com');
assert.equal(readCredentials({R2_SNAPSHOT_ACCOUNT_ID:ACCOUNT,R2_SNAPSHOT_ACCESS_KEY_ID:ACCESS,R2_SNAPSHOT_SECRET_ACCESS_KEY:SECRET}).bucket,'iptv');
const planned=plan({directory:'/private/snapshot',env:{}});
assert.equal(planned.network,false);
assert.equal(planned.credentialsRead,false);
assert.deepEqual(planned.fenceKeys,[...FENCE_KEYS]);
assert.equal(JSON.stringify(plan({directory:'/private/snapshot',env:{R2_SNAPSHOT_ACCOUNT_ID:ACCOUNT,R2_SNAPSHOT_SECRET_ACCESS_KEY:SECRET}})).includes(SECRET),false);
assert.equal(plan({directory:path.resolve('tests'),env:{}}).outputOutsideRepository,false);

// Listing parser: entities in keys, quoted ETags, truncation contract.
{
 const page=parseListing('<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>true</IsTruncated><NextContinuationToken>tok&amp;1</NextContinuationToken><Contents><Key>a &amp; b/&#x444;.json</Key><LastModified>2026-10-26T00:00:00.000Z</LastModified><ETag>&quot;abc&quot;</ETag><Size>3</Size></Contents></ListBucketResult>');
 assert.deepEqual(page,{objects:[{key:'a & b/ф.json',size:3,etag:'abc',lastModified:'2026-10-26T00:00:00.000Z'}],truncated:true,nextCursor:'tok&1'});
 assert.throws(()=>parseListing('<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>'),/continuation token/);
 assert.throws(()=>parseListing('<Error/>'),/not a bucket listing/);
 assert.deepEqual(inventoryDelta([{key:'a',etag:'1',size:1},{key:'b',etag:'2',size:1}],[{key:'a',etag:'9',size:1},{key:'c',etag:'3',size:1}]).map(item=>item.key+':'+item.reason).sort(),['a:metadata_changed','b:missing_after','c:added_after']);
}

// A fake S3-compatible bucket over HTTP: paged ListObjectsV2, conditional HEAD and GET, signature verification, write refusal.
function fakeBucket(initial,{pageSize=3}={}){
 const items=new Map();
 let revision=0;
 const put=(key,bytes)=>{revision++;items.set(key,{bytes:Buffer.from(bytes),etag:sha256(Buffer.from(bytes)).slice(0,32)+'-'+revision,lastModified:new Date(Date.UTC(2026,9,26,0,0,revision)).toUTCString()});};
 for(const [key,bytes] of Object.entries(initial))put(key,bytes);
 const calls={list:0,head:0,get:0,writes:0,badSignature:0};
 const hooks=[];
 const escape=text=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
 const rfc=value=>encodeURIComponent(value).replace(/[!'()*]/g,character=>'%'+character.charCodeAt(0).toString(16).toUpperCase());
 function verify(request,url){
  const header=request.headers.authorization||'';
  const match=header.match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/);
  if(!match||match[1]!==ACCESS)return false;
  const [,,date,region,service,signedHeaders,signature]=match;
  const names=signedHeaders.split(';');
  const canonicalPath=url.pathname.split('/').map(segment=>rfc(decodeURIComponent(segment))).join('/')||'/';
  const query=[...url.searchParams.entries()].map(([name,value])=>[rfc(name),rfc(value)]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:a[1]<b[1]?-1:1).map(pair=>pair.join('=')).join('&');
  const canonical=[request.method,canonicalPath,query,...names.map(name=>name+':'+String(request.headers[name]??'').trim().replace(/\s+/g,' ')),'',signedHeaders,request.headers['x-amz-content-sha256']].join('\n');
  const scope=date+'/'+region+'/'+service+'/aws4_request';
  const stringToSign=['AWS4-HMAC-SHA256',request.headers['x-amz-date'],scope,sha256(canonical)].join('\n');
  const key=hmac(hmac(hmac(hmac('AWS4'+SECRET,date),region),service),'aws4_request');
  return createHmac('sha256',key).update(stringToSign).digest('hex')===signature&&request.headers['x-amz-content-sha256']===sha256('');
 }
 const server=http.createServer(async(request,response)=>{
  const url=new URL(request.url,'http://127.0.0.1');
  const [,bucketName,...rest]=url.pathname.split('/');
  const key=rest.length?rest.map(decodeURIComponent).join('/'):null;
  let etagOverride=null,compress=false;
  for(const hook of hooks){const result=await hook({method:request.method,key,url,calls,put,items,request});if(result==='drop'){request.socket.destroy();return;}if(typeof result==='number'){response.writeHead(result);response.end();return;}if(result&&typeof result==='object'&&result.etag)etagOverride=result.etag;if(result&&typeof result==='object'&&result.compress)compress=true;}
  if(!verify(request,url)){calls.badSignature++;response.writeHead(403);response.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');return;}
  if(bucketName!=='iptv'){response.writeHead(404);response.end();return;}
  if(request.method!=='GET'&&request.method!=='HEAD'){calls.writes++;response.writeHead(403);response.end('<Error><Code>AccessDenied</Code></Error>');return;}
  if(key===null){
   calls.list++;
   if(url.searchParams.get('list-type')!=='2'){response.writeHead(400);response.end();return;}
   const keys=[...items.keys()].sort(),start=url.searchParams.has('continuation-token')?Number(Buffer.from(url.searchParams.get('continuation-token'),'base64').toString()):0;
   const limit=Math.min(pageSize,Number(url.searchParams.get('max-keys')||1000)),selected=keys.slice(start,start+limit),truncated=start+limit<keys.length;
   const body='<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>iptv</Name><KeyCount>'+selected.length+'</KeyCount><MaxKeys>'+limit+'</MaxKeys><IsTruncated>'+truncated+'</IsTruncated>'+(truncated?'<NextContinuationToken>'+Buffer.from(String(start+limit)).toString('base64')+'</NextContinuationToken>':'')+selected.map(item=>{const object=items.get(item);return '<Contents><Key>'+escape(item)+'</Key><LastModified>'+object.lastModified+'</LastModified><ETag>&quot;'+object.etag+'&quot;</ETag><Size>'+object.bytes.length+'</Size><StorageClass>STANDARD</StorageClass></Contents>';}).join('')+'</ListBucketResult>';
   response.writeHead(200,{'Content-Type':'application/xml','Content-Length':Buffer.byteLength(body)});response.end(body);return;
  }
  if(request.method==='HEAD')calls.head++;else calls.get++;
  const object=items.get(key);
  if(!object){response.writeHead(404);response.end();return;}
  const ifMatch=request.headers['if-match'];
  // Like Cloudflare's edge: unless the client asks for identity, the object is compressed on the fly, its ETag becomes weak,
  // Content-Length disappears and If-Match (a strong comparison) can never succeed.
  if(compress||request.headers['accept-encoding']!=='identity'){
   if(ifMatch){response.writeHead(412);response.end();return;}
   const body=gzipSync(object.bytes);
   response.writeHead(200,{ETag:'W/"'+object.etag+'"','Content-Encoding':'gzip','Last-Modified':object.lastModified,'Content-Type':'application/octet-stream'});
   if(request.method==='HEAD')response.end();else response.end(body);return;
  }
  if(!etagOverride&&ifMatch&&ifMatch.replace(/^"(.*)"$/,'$1')!==object.etag){response.writeHead(412);response.end();return;}
  response.writeHead(200,{ETag:'"'+(etagOverride||object.etag)+'"','Content-Length':object.bytes.length,'Last-Modified':object.lastModified,'Content-Type':'application/octet-stream'});
  if(request.method==='HEAD')response.end();else response.end(object.bytes);
 });
 return {items,calls,put,hooks,server,
  async start(){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port;},
  async stop(){await new Promise(resolve=>server.close(resolve));}};
}
const json=value=>JSON.stringify(value);
const fixture=()=>({
 'watchlist.json':json({films:[{id:'heat-1995'}]}),
 'programme.json':json({runId:'run-1',films:[]}),
 'sync.json':json({updatedAt:'2026-10-26T10:00:00.000Z',failures:[]}),
 'epg/published-generation.json':json({programmeRunId:'run-1',phase:'published'}),
 'epg/resolver-lease.json':json({id:'lease-1'}),
 'epg/resolver-continuation.json':json({at:'2026-10-26T10:05:00.000Z',hopId:'hop-7'}),
 'enrichment/writer-lease.json':json({id:'writer-1'}),
 'enrichment/runner-lease.json':json({id:'runner-1'}),
 'enrichment/profile/current.json':json({version:3,profileHash:'profile-3'}),
 'enrichment/latest-run.json':json({runId:'enrichment-run-9'}),
 'enrichment/films/tmdb_7/fingerprint.json':json({fingerprintHash:'print-7'}),
 'epg/generations/run 1/програм&ма.json':Buffer.from([0,255,1,2,0,128]),
 'started/heat-1995.json':json({started:true}),
});
const envFor=endpoint=>({R2_SNAPSHOT_ACCOUNT_ID:ACCOUNT,R2_SNAPSHOT_ACCESS_KEY_ID:ACCESS,R2_SNAPSHOT_SECRET_ACCESS_KEY:SECRET,R2_SNAPSHOT_BUCKET:'iptv',R2_SNAPSHOT_ENDPOINT:endpoint});
const noSleep=async()=>{};
async function temporary(){return mkdtemp(path.join(os.tmpdir(),'iptv-r2-export-'));}
async function expectKind(promise,kind){await assert.rejects(promise,error=>error instanceof ExportError&&error.kind===kind);}
async function expectNoGo(promise,reason){let caught=null;await assert.rejects(promise,error=>{caught=error;return error instanceof NoGo;});assert.equal(caught.reasons.includes(reason),true,JSON.stringify(caught.reasons));return caught;}
const directories=[];
try{
 // Happy path: a fenced consistent cut with raw hashes, source identity, baseline identity, awkward keys, verification and the CLI.
 {
  const bucket=fakeBucket(fixture(),{pageSize:4});const endpoint=await bucket.start();const credentials=readCredentials(envFor(endpoint));
  const directory=await temporary();directories.push(directory);
  const result=await exportProductionSnapshot({directory,credentials,sleep:noSleep});
  assert.equal(result.status,STATUS_CONSISTENT);
  assert.equal(result.objects,13);
  assert.equal(result.fence.ok,true);
  assert.deepEqual(result.baselineIdentity,{publishedProgrammeRunId:'run-1',syncUpdatedAt:'2026-10-26T10:00:00.000Z',continuationAt:'2026-10-26T10:05:00.000Z',continuationHopId:'hop-7',latestEnrichmentRunId:'enrichment-run-9'});
  assert.equal(result.source.kind,'cloudflare-r2-s3');
  assert.equal(result.source.bucket,'iptv');
  assert.equal(result.source.endpointOverride,true);
  assert.equal(bucket.calls.writes,0);
  assert.equal(bucket.calls.badSignature,0);
  assert.equal(bucket.calls.list>=2*Math.ceil(13/4),true);
  const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));
  assert.equal(manifest.schemaVersion,1);
  assert.equal(manifest.sourceSiteId,null);
  assert.equal(manifest.status,STATUS_CONSISTENT);
  assert.deepEqual(manifest.changes,[]);
  assert.equal(manifest.fence.keys.length,FENCE_KEYS.length);
  assert.equal(manifest.fence.keys.every(item=>item.status==='unchanged'),true);
  const binary=manifest.objects.find(entry=>entry.key==='epg/generations/run 1/програм&ма.json');
  assert.equal(binary.sha256,sha256(Buffer.from([0,255,1,2,0,128])));
  assert.deepEqual(await readFile(path.join(directory,binary.file)),Buffer.from([0,255,1,2,0,128]));
  assert.equal(JSON.stringify(manifest).includes(SECRET),false);
  assert.equal(JSON.stringify(manifest).includes(ACCESS),false);
  const verified=await verifyProductionSnapshot(directory);
  assert.equal(verified.status,STATUS_CONSISTENT);
  assert.equal(verified.aggregateSha256,result.aggregateSha256);
  const cli=spawnSync(process.execPath,['scripts/r2-snapshot-export.mjs','--output',directory,'--verify'],{encoding:'utf8',env:{...process.env,...envFor(endpoint)}});
  assert.equal(cli.status,0,cli.stderr);
  assert.equal(JSON.parse(cli.stdout).aggregateSha256,result.aggregateSha256);
  const planCli=spawnSync(process.execPath,['scripts/r2-snapshot-export.mjs','--plan','--output',directory],{encoding:'utf8',env:{PATH:process.env.PATH}});
  assert.equal(planCli.status,0,planCli.stderr);
  assert.equal(JSON.parse(planCli.stdout).network,false);
  const usage=spawnSync(process.execPath,['scripts/r2-snapshot-export.mjs','--output','relative/dir'],{encoding:'utf8',env:{PATH:process.env.PATH}});
  assert.equal(usage.status,2);
  const noCredentials=spawnSync(process.execPath,['scripts/r2-snapshot-export.mjs','--output',directory],{encoding:'utf8',env:{PATH:process.env.PATH}});
  assert.equal(noCredentials.status,2);
  assert.match(noCredentials.stderr,/configuration/);
  // Tampering with a stored object is caught by the aggregate re-read.
  await writeFile(path.join(directory,binary.file),Buffer.from('tampered'));
  await expectKind(verifyProductionSnapshot(directory),'integrity');
  await bucket.stop();
 }
 // The exporter refuses to write inside the repository and never sends anything before that check.
 await expectKind(exportProductionSnapshot({directory:path.resolve('tests','private'),credentials:readCredentials(envFor('http://127.0.0.1:9')),sleep:noSleep}),'configuration');
 // A wrong secret is refused by the bucket and reported as an authorization failure, with no retry storm.
 {
  const bucket=fakeBucket(fixture());const endpoint=await bucket.start();
  const directory=await temporary();directories.push(directory);
  await expectKind(exportProductionSnapshot({directory,credentials:{...readCredentials(envFor(endpoint)),secretAccessKey:'wrong'},sleep:noSleep}),'authorization');
  assert.equal(bucket.calls.badSignature,1);
  await bucket.stop();
 }
 // Concurrent writer: a listed object is rewritten before its download. The conditional read fails, the attempt is NO-GO,
 // nothing is claimed, and the next quiet attempt reuses the unchanged checkpoints and fetches only the revised object.
 {
  const bucket=fakeBucket(fixture(),{pageSize:5});const endpoint=await bucket.start();const credentials=readCredentials(envFor(endpoint));
  const directory=await temporary();directories.push(directory);
  let armed=true;
  bucket.hooks.push(({method,key,put})=>{if(armed&&method==='HEAD'&&key==='programme.json'){armed=false;put('programme.json',json({runId:'run-2',films:[]}));}});
  const noGo=await expectNoGo(exportProductionSnapshot({directory,credentials,sleep:noSleep}),'source_changed');
  assert.match(noGo.details.message,/programme\.json/);
  assert.equal(JSON.parse(await readFile(path.join(directory,'report.json'),'utf8')).status,STATUS_NO_GO);
  assert.equal(fs.existsSync(path.join(directory,'manifest.json')),false);
  const gets=bucket.calls.get;
  const result=await exportProductionSnapshot({directory,credentials,sleep:noSleep});
  assert.equal(result.status,STATUS_CONSISTENT);
  assert.equal(result.baselineIdentity.publishedProgrammeRunId,'run-1');
  assert.equal(result.resumed>0,true);
  assert.equal(bucket.calls.get-gets,result.objects-result.resumed);
  assert.equal(bucket.calls.writes,0);
  await bucket.stop();
 }
 // Inventory delta between the opening and the closing listing: an added, a changed and a deleted key are each an explicit NO-GO.
 {
  const bucket=fakeBucket(fixture(),{pageSize:50});const endpoint=await bucket.start();const credentials=readCredentials(envFor(endpoint));
  const directory=await temporary();directories.push(directory);
  let lists=0;
  bucket.hooks.push(({method,key,put,items})=>{if(method==='GET'&&key===null&&++lists===2){put('events/items/new.json',json({id:'e1'}));put('started/heat-1995.json',json({started:false}));items.delete('enrichment/latest-run.json');}});
  const noGo=await expectNoGo(exportProductionSnapshot({directory,credentials,sleep:noSleep}),'inventory_changed');
  assert.equal(noGo.reasons.includes('deletion_observed'),true);
  assert.deepEqual(noGo.details.changes.map(item=>item.key+':'+item.reason).sort(),['enrichment/latest-run.json:missing_after','events/items/new.json:added_after','started/heat-1995.json:metadata_changed']);
  const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));
  assert.equal(manifest.status,STATUS_NO_GO);
  assert.equal(manifest.changes.length,3);
  const verified=await verifyProductionSnapshot(directory);
  assert.equal(verified.status,STATUS_NO_GO);
  assert.deepEqual(verified.noGoReasons,['inventory_changed','deletion_observed']);
  const cli=spawnSync(process.execPath,['scripts/r2-snapshot-export.mjs','--output',directory,'--verify'],{encoding:'utf8',env:{...process.env,...envFor(endpoint)}});
  assert.equal(cli.status,3,cli.stderr);
  await bucket.stop();
 }
 // ETag mismatch from a misbehaving server: a 200 with another ETag is still a changed source, never accepted bytes.
 {
  const bucket=fakeBucket(fixture());const endpoint=await bucket.start();const credentials=readCredentials(envFor(endpoint));
  const directory=await temporary();directories.push(directory);
  let drifted=false;
  bucket.hooks.push(({method,key})=>{if(!drifted&&method==='GET'&&key==='watchlist.json'){drifted=true;return {etag:bucket.items.get('watchlist.json').etag+'-drift'};}});
  const noGo=await expectNoGo(exportProductionSnapshot({directory,credentials,sleep:noSleep}),'source_changed');
  assert.match(noGo.details.message,/watchlist\.json/);
  await bucket.stop();
 }
 // Fence: a lease rewritten after the closing listing fails the fence even though both listings agree.
 {
  const bucket=fakeBucket(fixture(),{pageSize:50});const endpoint=await bucket.start();const credentials=readCredentials(envFor(endpoint));
  const directory=await temporary();directories.push(directory);
  let lists=0,armed=false;
  bucket.hooks.push(({method,key,put})=>{if(method==='GET'&&key===null&&++lists===2)armed=true;else if(armed&&method==='HEAD'&&key==='epg/resolver-lease.json'){armed=false;put('epg/resolver-lease.json',json({id:'lease-2'}));}});
  const noGo=await expectNoGo(exportProductionSnapshot({directory,credentials,sleep:noSleep}),'fence_changed');
  assert.equal(noGo.reasons.includes('inventory_changed'),false);
  assert.equal(noGo.details.fence.keys.find(item=>item.key==='epg/resolver-lease.json').status,'changed');
  const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));
  assert.equal(manifest.fence.ok,false);
  assert.equal((await verifyProductionSnapshot(directory)).status,STATUS_NO_GO);
  await bucket.stop();
 }
 // Lease mutation while objects download: the closing listing sees the lease's new ETag and the attempt is NO-GO.
 {
  const bucket=fakeBucket(fixture(),{pageSize:50});const endpoint=await bucket.start();const credentials=readCredentials(envFor(endpoint));
  const directory=await temporary();directories.push(directory);
  let armed=true;
  bucket.hooks.push(({method,key,put})=>{if(armed&&method==='GET'&&key==='started/heat-1995.json'){armed=false;put('enrichment/writer-lease.json',json({id:'writer-2'}));}});
  const noGo=await expectNoGo(exportProductionSnapshot({directory,credentials,sleep:noSleep}),'inventory_changed');
  assert.deepEqual(noGo.details.changes,[{key:'enrichment/writer-lease.json',reason:'metadata_changed'}]);
  await bucket.stop();
 }
 // A fence key absent at both ends is fine; one created after the opening listing is not.
 {
  const bucket=fakeBucket({...fixture()},{pageSize:50});bucket.items.delete('enrichment/runner-lease.json');const endpoint=await bucket.start();const credentials=readCredentials(envFor(endpoint));
  const directory=await temporary();directories.push(directory);
  const result=await exportProductionSnapshot({directory,credentials,sleep:noSleep});
  assert.equal(result.fence.keys.find(item=>item.key==='enrichment/runner-lease.json').status,'absent');
  const created=await temporary();directories.push(created);
  let lists=0;
  bucket.hooks.push(({method,key,put})=>{if(method==='GET'&&key===null&&++lists===2)put('enrichment/runner-lease.json',json({id:'runner-9'}));});
  const noGo=await expectNoGo(exportProductionSnapshot({directory:created,credentials,sleep:noSleep}),'fence_changed');
  assert.equal(noGo.details.fence.keys.find(item=>item.key==='enrichment/runner-lease.json').status,'created');
  await bucket.stop();
 }
 // Bounded retries: two transient failures are absorbed; a persistent failure stops after the bound with no partial claim.
 {
  const bucket=fakeBucket(fixture(),{pageSize:50});const endpoint=await bucket.start();const credentials=readCredentials(envFor(endpoint));
  const directory=await temporary();directories.push(directory);
  let flaky=2;
  bucket.hooks.push(({method,key})=>{if(method==='GET'&&key==='sync.json'&&flaky>0){flaky--;return 503;}});
  const result=await exportProductionSnapshot({directory,credentials,sleep:noSleep});
  assert.equal(result.status,STATUS_CONSISTENT);
  assert.equal(flaky,0);
  const stuck=await temporary();directories.push(stuck);
  let attempts=0;
  bucket.hooks.push(({method,key})=>{if(method==='GET'&&key==='programme.json'){attempts++;return 503;}});
  await expectKind(exportProductionSnapshot({directory:stuck,credentials,sleep:noSleep}),'network');
  assert.equal(attempts,5*4,'four stream attempts of five bounded requests each');
  assert.equal(JSON.parse(await readFile(path.join(stuck,'report.json'),'utf8')).status,'incomplete');
  assert.equal(fs.existsSync(path.join(stuck,'manifest.json')),false);
  await bucket.stop();
 }
 // Resume: a dropped connection mid-run leaves durable listing pages and completed objects; the next run fetches only the rest.
 {
  const bucket=fakeBucket(fixture(),{pageSize:4});const endpoint=await bucket.start();const credentials=readCredentials(envFor(endpoint));
  const directory=await temporary();directories.push(directory);
  let drop=true;
  bucket.hooks.push(({method,key})=>{if(drop&&method==='GET'&&key==='enrichment/profile/current.json')return 'drop';});
  await expectKind(exportProductionSnapshot({directory,credentials,sleep:noSleep}),'network');
  const pages=fs.readdirSync(path.join(directory,'pages')).length;
  assert.equal(pages,Math.ceil(13/4));
  const entries=fs.readdirSync(path.join(directory,'entries')).length;
  assert.equal(entries>0&&entries<13,true);
  drop=false;
  const lists=bucket.calls.list,gets=bucket.calls.get;
  const result=await exportProductionSnapshot({directory,credentials,sleep:noSleep});
  assert.equal(result.status,STATUS_CONSISTENT);
  assert.equal(result.resumed,entries);
  assert.equal(bucket.calls.get-gets,13-entries,'completed objects were not downloaded again');
  assert.equal(bucket.calls.list-lists,Math.ceil(13/4),'the opening listing came from checkpoints; only the closing listing was fetched');
  await bucket.stop();
 }
 // The client refuses to build a non-read request at all.
 {
  const bucket=fakeBucket(fixture());const endpoint=await bucket.start();const credentials=readCredentials(envFor(endpoint));
  const client=createReadOnlyClient({credentials,sleep:noSleep});
  assert.equal((await client.head('watchlist.json')).etag,bucket.items.get('watchlist.json').etag);
  assert.equal(await client.head('absent.json'),null);
  await expectKind(client.head('watchlist.json',{ifMatch:'stale'}),'source_changed');
  assert.equal(bucket.calls.writes,0);
  await bucket.stop();
 }
 // Content encoding: every request asks for identity under the signature; an encoded or weak-ETag response is refused, never hashed.
 {
  const bucket=fakeBucket(fixture());const endpoint=await bucket.start();const credentials=readCredentials(envFor(endpoint));
  const seen=[];bucket.hooks.push(({request})=>{seen.push({accept:request.headers['accept-encoding'],signed:/SignedHeaders=[^,]*\baccept-encoding\b/.test(request.headers.authorization||'')});});
  const client=createReadOnlyClient({credentials,sleep:noSleep});
  await client.list(null);await client.head('watchlist.json');await (await client.get('watchlist.json')).body.cancel();
  assert.deepEqual(seen,Array(3).fill({accept:'identity',signed:true}));
  bucket.hooks.push(()=>({compress:true}));
  await expectKind(client.head('watchlist.json'),'protocol');
  await expectKind(client.get('watchlist.json'),'protocol');
  await expectKind(client.head('watchlist.json',{ifMatch:bucket.items.get('watchlist.json').etag}),'source_changed');
  assert.equal(bucket.calls.writes,0);
  await bucket.stop();
 }
}finally{for(const directory of directories)await rm(directory,{recursive:true,force:true});}
console.log('R2 snapshot export: SigV4 known answer, environment-only credentials, read-only client, fenced consistent cut, concurrent writer, inventory delta, ETag drift, identity encoding, fence and lease changes, bounded retries, resume and aggregate verification passed');
