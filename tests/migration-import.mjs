import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,stat,writeFile,chmod} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {exportSnapshot} from '../scripts/migration-export.mjs';
import http from 'node:http';
import {ImportError,assertTarget,canonicalUri,createMemoryBucket,createR2Client,dryRun,importSnapshot,isLeaseKey,parseAuth,runCli,signRequest,verifyDestination} from '../scripts/migration-import.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const account='a'.repeat(32);
const auth={accountId:account,confirmAccountId:account,bucket:'iptv',accessKeyId:'AKIAIOSFODNN7EXAMPLE',secretAccessKey:'secret'};
const directories=[];
async function temporary(){const directory=await mkdtemp(path.join(os.tmpdir(),'iptv-import-test-'));directories.push(directory);return directory;}
async function expectKind(promise,kind){await assert.rejects(promise,error=>{assert.equal(error.kind,kind);return true;});}
function sourceBucket(values){
 const items=new Map(Object.entries(values).map(([key,input],index)=>[key,{key,bytes:Buffer.from(input.bytes),size:input.bytes.length,etag:'etag-'+index,version:'version-'+index,uploaded:new Date('2026-10-19T00:00:00Z'),httpMetadata:input.httpMetadata||{},customMetadata:input.customMetadata||{},storageClass:'Standard'}]));
 const calls={list:0,head:0,get:0,put:0,delete:0};
 const metadata=item=>({key:item.key,size:item.size,etag:item.etag,version:item.version,uploaded:item.uploaded,httpMetadata:item.httpMetadata,customMetadata:item.customMetadata,storageClass:item.storageClass});
 return {items,calls,async list({cursor}){calls.list++;const keys=[...items.keys()].sort(),start=cursor?Number(cursor):0,selected=keys.slice(start,start+10);return {objects:selected.map(key=>metadata(items.get(key))),truncated:start+10<keys.length,cursor:start+10<keys.length?String(start+10):undefined};},async head(key){calls.head++;return items.has(key)?metadata(items.get(key)):null;},async get(key,options){calls.get++;const item=items.get(key);if(!item)return null;return {...metadata(item),...(options?.onlyIf?.etagMatches===item.etag?{body:new Response(item.bytes).body}:{})};},async put(){calls.put++;throw Error('source must not change');},async delete(){calls.delete++;throw Error('source must not change');}};
}
async function snapshot(values){
 const directory=await temporary(),store=sourceBucket(values);
 const env={BUCKET:store,MIGRATION_EXPORT_ENABLED:'true',MIGRATION_EXPORT_SITE_ID:'appgprj_6abfed826e148191903dec4175166ff7',MIGRATION_EXPORT_KEY:'test-export-key'};
 const {readFile:read}=await import('node:fs/promises');
 const vm=await import('node:vm');
 const context=vm.createContext({Response,Request,URL,JSON,Date,crypto:(await import('node:crypto')).webcrypto});
 vm.runInContext(await read('src/migration-export.js','utf8')+'\nglobalThis.handleMigrationExport=migrationExportRoute;',context);
 const fetchImpl=async(input,options={})=>{const request=new Request(input,options);return context.handleMigrationExport(request,env,new URL(request.url));};
 await exportSnapshot({directory,headers:{'X-Migration-Export-Key':'test-export-key'},fetchImpl});
 assert.equal(store.calls.put+store.calls.delete,0);
 return directory;
}

const signed=signRequest({method:'GET',path:'/test.txt',query:new URLSearchParams(),headers:{host:'examplebucket.s3.amazonaws.com',range:'bytes=0-9','x-amz-content-sha256':'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855','x-amz-date':'20130524T000000Z'},payloadHash:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',accessKeyId:'AKIAIOSFODNN7EXAMPLE',secretAccessKey:'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',amzDate:'20130524T000000Z',region:'us-east-1',service:'s3'});
assert.match(signed.authorization,/Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
assert.throws(()=>assertTarget({...auth,bucket:'other'}),ImportError);
assert.throws(()=>assertTarget({...auth,confirmAccountId:'b'.repeat(32)}),ImportError);
assert.equal(parseAuth(JSON.stringify(auth)).bucket,'iptv');
assert.equal(isLeaseKey('enrichment/runner-lease.json')&&isLeaseKey('epg/resolver-lease.json'),true);

try{
 const directory=await snapshot({'watchlist.json':{bytes:Buffer.from('{"films":[]}'),httpMetadata:{contentType:'application/json'},customMetadata:{role:'durable'}},'films/фильм.bin':{bytes:Buffer.from([0,255,10,0])},'enrichment/runner-lease.json':{bytes:Buffer.from('{"expiresAt":1}'),httpMetadata:{contentType:'application/json'}}});
 const destination=createMemoryBucket();
 const plan=await dryRun({directory,client:destination,auth});
 assert.equal(plan.operation,'dry-run');assert.equal(plan.objects,3);assert.equal(plan.upload,3);assert.equal(plan.leases,1);assert.equal(destination.calls.put,0);assert.equal(destination.writes,0);

 const imported=await importSnapshot({directory,client:destination,auth});
 assert.equal(imported.upload,3);assert.equal(destination.calls.put,3);
 assert.deepEqual(destination.items.get('films/фильм.bin').bytes,Buffer.from([0,255,10,0]));
 assert.equal(destination.items.get('watchlist.json').metadata.httpMetadata.contentType,'application/json');
 assert.equal(destination.items.get('watchlist.json').metadata.customMetadata.role,'durable');
 assert.equal(destination.items.get('enrichment/runner-lease.json').bytes.toString(),'{"expiresAt":1}');
 const repeated=await importSnapshot({directory,client:destination,auth});
 assert.equal(repeated.upload,0);assert.equal(destination.calls.put,3);
 assert.equal((await verifyDestination({directory,client:destination,auth})).objects,3);

 const broken=await snapshot({'a.json':{bytes:Buffer.from('{"ok":true}')}});
 const file=JSON.parse(await readFile(path.join(broken,'manifest.json'),'utf8')).objects[0].file;
 const body=await readFile(path.join(broken,file));body[0]^=1;await writeFile(path.join(broken,file),body);
 await expectKind(dryRun({directory:broken,client:createMemoryBucket(),auth}),'snapshot');
 const checksum=await snapshot({'b.json':{bytes:Buffer.from('{"n":1}')}});
 const manifest=JSON.parse(await readFile(path.join(checksum,'manifest.json'),'utf8'));manifest.objects[0].sha256='0'.repeat(64);await writeFile(path.join(checksum,'manifest.json'),JSON.stringify(manifest));
 await expectKind(dryRun({directory:checksum,client:createMemoryBucket(),auth}),'snapshot');

 await expectKind(dryRun({directory,client:destination,auth:{...auth,bucket:'foreign'}}),'target');
 await expectKind(dryRun({directory,client:createMemoryBucket(),auth:{...auth,confirmAccountId:'c'.repeat(32)}}),'target');
 assert.equal(destination.calls.put,3);

 const conflict=createMemoryBucket();
 await conflict.put('watchlist.json',Buffer.from('different'),{httpMetadata:{contentType:'application/json'},customMetadata:{role:'durable'}});
 const puts=conflict.calls.put;
 await expectKind(importSnapshot({directory,client:conflict,auth}),'conflict');
 assert.equal(conflict.items.get('watchlist.json').bytes.toString(),'different');assert.equal(conflict.calls.put,puts);

 let interrupted=0;const resume=createMemoryBucket(),realPut=resume.put.bind(resume);
 resume.put=async(key,bytes,metadata)=>{interrupted++;await realPut(key,bytes,metadata);if(interrupted===1)throw new ImportError('network','interrupted');};
 await expectKind(importSnapshot({directory,client:resume,auth}),'network');
 const second=await importSnapshot({directory,client:resume,auth});
 assert.equal(second.upload,2);assert.equal(resume.calls.put,3);assert.equal(resume.items.size,3);

 const extra=createMemoryBucket();await extra.put('unexpected/object',Buffer.from('x'),{});
 await expectKind(dryRun({directory,client:extra,auth}),'extra');assert.equal(extra.calls.put,1);
 const missing=createMemoryBucket();await importSnapshot({directory,client:missing,auth});missing.items.delete('watchlist.json');
 await expectKind(verifyDestination({directory,client:missing,auth}),'missing');
 const metadata=createMemoryBucket();await importSnapshot({directory,client:metadata,auth});
 metadata.items.get('watchlist.json').metadata.customMetadata.role='changed';
 await expectKind(verifyDestination({directory,client:metadata,auth}),'metadata');
 assert.equal(destination.calls.delete||0,0);

 const authFile=path.join(await temporary(),'r2-auth.json');
 await writeFile(authFile,JSON.stringify(auth),{mode:0o644});await chmod(authFile,0o644);
 await expectKind(runCli(['import','--snapshot',directory,'--auth-file',authFile]),'usage');
 await expectKind(runCli(['import','--snapshot',directory,'--auth-file',authFile,'--confirm-import']),'authorization');
 await chmod(authFile,0o600);
 let fetched=0;const client=createR2Client(auth,{requestImpl:async()=>{fetched++;return {status:200,headers:new Headers(),body:Buffer.from('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>')};}});
 const output=[];await runCli(['dry-run','--snapshot',directory,'--auth-file',authFile],{clientFor:()=>client,stdout:line=>output.push(line)});
 assert.equal(JSON.parse(output[0]).writes,0);assert.equal(fetched,1);assert.equal((await stat(authFile)).mode&0o777,0o600);
 assert.equal(canonicalUri('iptv','dir//фильм !*\'()'),'/iptv/dir//%D1%84%D0%B8%D0%BB%D1%8C%D0%BC%20%21%2A%27%28%29');

 const raced=createMemoryBucket();let racedKey='';const originalPut=raced.put.bind(raced);
 raced.put=async(key,bytes,metadata,options)=>{if(!racedKey){racedKey=key;raced.items.set(key,{key,bytes:Buffer.from('racer'),metadata:{httpMetadata:{},customMetadata:{}}});}return originalPut(key,bytes,metadata,options);};
 await expectKind(importSnapshot({directory,client:raced,auth}),'conflict');
 assert.equal(raced.items.get(racedKey).bytes.toString(),'racer','a concurrent create is not overwritten');

 const recorded=[];const gzip=Buffer.from([0x1f,0x8b,0x08,0x00,0xff,0x01]);let lists=0;
 const server=http.createServer((request,response)=>{
  recorded.push({method:request.method,url:request.url,headers:request.headers});
  if(request.url.includes('list-type=2')){lists++;if(lists===1){response.writeHead(503);response.end('busy');return;}if(lists===2){response.writeHead(200,{'content-type':'application/xml'});response.end('<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>page&amp;2</NextContinuationToken><Contents><Key>a&amp;b</Key><Size>1</Size></Contents></ListBucketResult>');return;}response.writeHead(200,{'content-type':'application/xml'});response.end('<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>dir//name</Key><Size>1</Size></Contents></ListBucketResult>');return;}
  if(request.method==='PUT'){response.writeHead(request.url.endsWith('/race-key')?412:200);response.end();return;}
  if(request.method==='GET'){response.writeHead(200,{'content-encoding':'gzip','content-type':'application/octet-stream','content-length':String(gzip.length)});response.end(gzip);return;}
  response.writeHead(200);response.end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const endpoint=`http://127.0.0.1:${server.address().port}`,local=createR2Client(auth,{endpoint});
 assert.deepEqual((await local.listAll()).map(item=>item.key),['a&b','dir//name']);
 assert.equal(lists,3,'listing retries a transient error and follows the continuation token');
 assert.equal(recorded.filter(item=>item.url.includes('continuation-token=page%262')).length,1);
 const raw=await local.get('gzip-object');
 assert.deepEqual(raw,gzip);
 await expectKind(local.put('race-key',Buffer.from('new'),{httpMetadata:{cacheExpiry:'2026-11-06T08:49:37.000Z'}}),'conflict');
 assert.equal(recorded.some(item=>item.method==='PUT'&&item.headers['if-none-match']==='*'&&item.headers.expires==='Fri, 06 Nov 2026 08:49:37 GMT'),true);
 const encoded=canonicalUri('iptv','dir//фильм !*\'()');
 await local.head('dir//фильм !*\'()');
 assert.equal(recorded.at(-1).url,encoded);
 const duplicate=createR2Client(auth,{endpoint:'http://127.0.0.1:9',requestImpl:async()=>({status:200,headers:new Headers(),body:Buffer.from('<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>a</Key><Size>1</Size></Contents><Contents><Key>a</Key><Size>1</Size></Contents></ListBucketResult>')})});
 await expectKind(duplicate.listAll(),'target');
 let repeatPage=0;const looping=createR2Client(auth,{endpoint:'http://127.0.0.1:9',requestImpl:async()=>({status:200,headers:new Headers(),body:Buffer.from(++repeatPage===1?'<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>again</NextContinuationToken><Contents><Key>a</Key><Size>1</Size></Contents></ListBucketResult>':'<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>again</NextContinuationToken><Contents><Key>b</Key><Size>1</Size></Contents></ListBucketResult>')})});
 await expectKind(looping.listAll(),'target');
 server.close();
}finally{await Promise.all(directories.map(directory=>rm(directory,{recursive:true,force:true})));}
console.log('R2 import: dry-run, import, verify, corrupt snapshot, checksum, target, conflict, resume, missing, extra, metadata, leases and no dry-run writes passed');
