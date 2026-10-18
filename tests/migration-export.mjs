import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {exportSnapshot,verifySnapshot,ExportError} from '../scripts/migration-export.mjs';

const source=await readFile('src/migration-export.js','utf8');
const context=vm.createContext({Response,Request,URL,JSON,Date,crypto:webcrypto});
vm.runInContext(source+'\nglobalThis.handleMigrationExport=migrationExportRoute;',context);
const origin='https://iptv.vladimino.chatgpt.site',headers={'X-Migration-Export-Key':'test-export-key'};
const hash=value=>createHash('sha256').update(value).digest('hex');
function bucket(values,{pageSize=17}={}){
 const items=new Map(Object.entries(values).map(([key,input],index)=>[key,{key,bytes:Buffer.from(input.bytes),size:input.bytes.length,etag:'etag-'+index,version:'version-'+index,uploaded:new Date('2026-10-18T12:00:00Z'),httpMetadata:input.httpMetadata||{},customMetadata:input.customMetadata||{},storageClass:'Standard'}]));
 const calls={list:0,head:0,get:0,put:0,delete:0};
 const metadata=item=>({key:item.key,size:item.size,etag:item.etag,version:item.version,uploaded:item.uploaded,httpMetadata:item.httpMetadata,customMetadata:item.customMetadata,storageClass:item.storageClass});
 return {items,calls,
  async list({cursor}){calls.list++;const keys=[...items.keys()].sort(),start=cursor?Number(cursor):0,selected=keys.slice(start,start+pageSize);return {objects:selected.map(key=>metadata(items.get(key))),truncated:start+pageSize<keys.length,cursor:start+pageSize<keys.length?String(start+pageSize):undefined};},
  async head(key){calls.head++;return items.has(key)?metadata(items.get(key)):null;},
  async get(key,options){calls.get++;const item=items.get(key);if(!item)return null;return {...metadata(item),...(options?.onlyIf?.etagMatches===item.etag?{body:new Response(item.bytes).body}:{})};},
  async put(){calls.put++;throw Error('Exporter must not write');},
  async delete(){calls.delete++;throw Error('Exporter must not delete');}
 };
}
function connection(store,intercept){
 const env={BUCKET:store,MIGRATION_EXPORT_ENABLED:'true',MIGRATION_EXPORT_SITE_ID:'appgprj_6abfed826e148191903dec4175166ff7',MIGRATION_EXPORT_KEY:'test-export-key'};
 const fetchImpl=async(input,options={})=>{
  const request=new Request(input,options),url=new URL(request.url);
  if(intercept){const result=await intercept({request,url,store});if(result)return result;}
  return context.handleMigrationExport(request,env,url);
 };
 return {env,fetchImpl};
}
async function temporary(){return mkdtemp(path.join(os.tmpdir(),'iptv-export-test-'));}
async function expectKind(promise,kind){await assert.rejects(promise,error=>error instanceof ExportError&&error.kind===kind);}

// The endpoint is fail-closed, GET-only, and never mutates the bucket.
{
 const store=bucket({'binary/one':{bytes:Buffer.from([0,255,1,0])}}),{env,fetchImpl}=connection(store);
 const wrong=await context.handleMigrationExport(new Request(origin+'/api/migration-export/list'),env,new URL(origin+'/api/migration-export/list'));
 assert.equal(wrong.status,404);
 const post=await context.handleMigrationExport(new Request(origin+'/api/migration-export/list',{method:'POST',headers}),env,new URL(origin+'/api/migration-export/list'));
 assert.equal(post.status,405);
 assert.equal((await fetchImpl(origin+'/api/migration-export/list',{headers})).status,200);
 assert.equal(store.calls.put+store.calls.delete,0);
}

const directories=[];
try{
 // Empty bucket and portable binary/metadata snapshot.
 const emptyDir=await temporary();directories.push(emptyDir);
 const empty=bucket({});let result=await exportSnapshot({directory:emptyDir,headers,fetchImpl:connection(empty).fetchImpl});
 assert.equal(result.objects,0);assert.equal(result.bytes,0);assert.equal(empty.calls.put+empty.calls.delete,0);
 const binaryDir=await temporary();directories.push(binaryDir);
 const raw=Buffer.from([0,1,2,255,0,128,10]),store=bucket({'binary/фильм.dat':{bytes:raw,httpMetadata:{contentType:'application/x-example',cacheControl:'private'},customMetadata:{note:'кино'}}});
 result=await exportSnapshot({directory:binaryDir,headers,fetchImpl:connection(store).fetchImpl});
 assert.equal(result.objects,1);const manifest=JSON.parse(await readFile(path.join(binaryDir,'manifest.json'),'utf8'));
 assert.equal(manifest.objects[0].key,'binary/фильм.dat');assert.equal(manifest.objects[0].sha256,hash(raw));
 assert.equal(manifest.objects[0].metadata.httpMetadata.contentType,'application/x-example');
 assert.equal(manifest.objects[0].metadata.customMetadata.note,'кино');
 assert.deepEqual(await readFile(path.join(binaryDir,manifest.objects[0].file)),raw);
 assert.equal(store.calls.put+store.calls.delete,0);

 // Thousands of objects, with R2 returning fewer than requested per page.
 const manyDir=await temporary();directories.push(manyDir);
 const inputs=Object.fromEntries(Array.from({length:2001},(_,index)=>['prefix'+index%3+'/item-'+String(index).padStart(4,'0'),{bytes:Buffer.from('record-'+index)}]));
 const many=bucket(inputs,{pageSize:37});result=await exportSnapshot({directory:manyDir,headers,fetchImpl:connection(many).fetchImpl});
 assert.equal(result.objects,2001);assert(many.calls.list>100);assert.equal(result.bytes,Object.values(inputs).reduce((sum,item)=>sum+item.bytes.length,0));
 assert.equal((await verifySnapshot(manyDir)).aggregateSha256,result.aggregateSha256);
 assert.equal(many.calls.put+many.calls.delete,0);

 // A failed stream keeps completed objects and all listing pages for resume.
 const resumeDir=await temporary();directories.push(resumeDir);
 const resumed=bucket({'a':{bytes:Buffer.from('A')},'b':{bytes:Buffer.from('B')},'c':{bytes:Buffer.from('C')}},{pageSize:1});
 let fail=true;const interrupted=connection(resumed,({url})=>{if(fail&&url.pathname.endsWith('/object')&&url.searchParams.get('key')==='b')throw Error('network interruption');});
 await expectKind(exportSnapshot({directory:resumeDir,headers,fetchImpl:interrupted.fetchImpl}),'network');
 const firstGetCount=resumed.calls.get;fail=false;
 result=await exportSnapshot({directory:resumeDir,headers,fetchImpl:interrupted.fetchImpl});
 assert.equal(result.objects,3);assert.equal(resumed.calls.get-firstGetCount,2,'completed object was not downloaded again');

 // Interrupted listing resumes from the last durable cursor checkpoint.
 const listResumeDir=await temporary();directories.push(listResumeDir);
 const listResume=bucket({'a':{bytes:Buffer.from('A')},'b':{bytes:Buffer.from('B')},'c':{bytes:Buffer.from('C')}},{pageSize:1});
 let failListing=true;const listConnection=connection(listResume,({url})=>{if(failListing&&url.pathname.endsWith('/list')&&url.searchParams.get('cursor')==='1')throw Error('listing interruption');});
 await expectKind(exportSnapshot({directory:listResumeDir,headers,fetchImpl:listConnection.fetchImpl}),'network');
 assert.equal((await readFile(path.join(listResumeDir,'pages','00000000.json'),'utf8')).includes('nextCursor'),true);
 failListing=false;result=await exportSnapshot({directory:listResumeDir,headers,fetchImpl:listConnection.fetchImpl});assert.equal(result.objects,3);

 // A source update between listing and transfer must not be called consistent.
 const changedDir=await temporary();directories.push(changedDir);
 const changed=bucket({'x':{bytes:Buffer.from('old')}});
 let changedOnce=false;const changedConnection=connection(changed,({url})=>{if(!changedOnce&&url.pathname.endsWith('/head')){const item=changed.items.get('x');item.bytes=Buffer.from('new');item.size=3;item.etag='new-etag';item.version='new-version';changedOnce=true;}});
 await expectKind(exportSnapshot({directory:changedDir,headers,fetchImpl:changedConnection.fetchImpl}),'source_changed');
 assert.equal(JSON.parse(await readFile(path.join(changedDir,'report.json'),'utf8')).status,'incomplete');

 // A key that vanishes after transfer is reported by the independent final listing.
 const missingDir=await temporary();directories.push(missingDir);
 const missing=bucket({'x':{bytes:Buffer.from('one')},'y':{bytes:Buffer.from('two')}});
 let listed=0;const missingConnection=connection(missing,({url})=>{if(url.pathname.endsWith('/list')&&++listed===2)missing.items.delete('y');});
 result=await exportSnapshot({directory:missingDir,headers,fetchImpl:missingConnection.fetchImpl});
 assert.equal(result.status,'inconsistent');assert.equal(JSON.parse(await readFile(path.join(missingDir,'manifest.json'),'utf8')).changes[0].reason,'missing_after');

 // Duplicate keys across pages and local checksum corruption are both fatal.
 const duplicateDir=await temporary();directories.push(duplicateDir);
 const duplicate=bucket({'x':{bytes:Buffer.from('one')},'y':{bytes:Buffer.from('two')}},{pageSize:1});
 let pages=0;const duplicateConnection=connection(duplicate,async({url,request})=>{if(url.pathname.endsWith('/list')&&++pages===2)return new Response(JSON.stringify({objects:[{key:'x',size:3,etag:'etag-0',version:'version-0'}],truncated:false,nextCursor:null}),{headers:{'Content-Type':'application/json'}});});
 await expectKind(exportSnapshot({directory:duplicateDir,headers,fetchImpl:duplicateConnection.fetchImpl}),'listing');
 await writeFile(path.join(binaryDir,manifest.objects[0].file),Buffer.from('tampered'));
 await expectKind(verifySnapshot(binaryDir),'integrity');
}finally{for(const directory of directories)await rm(directory,{recursive:true,force:true});}
console.log('Migration export: owner gate, full pagination, 2001 objects, binary/metadata, resume, source changes, duplicate/missing keys, checksums and read-only calls passed');
