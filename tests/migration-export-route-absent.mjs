// The retired Site served `/api/migration-export/*`, a read of any R2 object by key, to its snapshot exporter. The Worker no longer
// carries that route. This test runs the BUILT Worker (dist/server/index.js, not the test double under tests/support) with the
// exporter's former origin, flags and key, which is the best case the old guard could ask for, and requires the paths to answer 404
// without a single call on the bucket. A foreign Origin on a POST or PUT meets the dispatcher's origin check first and gets 403.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const build=spawnSync(process.execPath,[path.join(root,'build.mjs')],{cwd:root,stdio:'inherit'});
assert.equal(build.status,0,'the Worker builds');

// 1. The route is not in the bundle: neither its path, its handler, its key header nor the legacy site id it was pinned to. The three
// MIGRATION_EXPORT_* names stay in the isolated EPG diagnostic environment's deny list on purpose (src/epg-diagnostic.js): they must
// never be copied into that environment, so their appearance there is not the route.
const bundle=fs.readFileSync(path.join(root,'dist/server/index.js'),'utf8');
for(const needle of ['migration-export','migrationExportRoute','MIGRATION_SOURCE_SITE_ID','X-Migration-Export-Key','appgprj_6abfed826e148191903dec4175166ff7','iptv.vladimino.chatgpt.site'])assert.equal(bundle.includes(needle),false,`the bundle does not contain ${needle}`);

// 2. A bucket that records every call: any access at all fails the test.
const calls=[];
const bucket=new Proxy({},{get:(_,name)=>(...args)=>{calls.push(String(name));throw new Error('bucket must not be touched: '+String(name)+' '+JSON.stringify(args).slice(0,80));}});
// The exporter's former environment, as the old guard needed it.
const env={BUCKET:bucket,MIGRATION_EXPORT_ENABLED:'true',MIGRATION_EXPORT_SITE_ID:'appgprj_6abfed826e148191903dec4175166ff7',MIGRATION_EXPORT_KEY:'test-export-key'};
const worker=(await import(pathToFileURL(path.join(root,'dist/server/index.js')).href)).default;
const keyHeaders={'X-Migration-Export-Key':'test-export-key'};
const oldOrigin='https://iptv.vladimino.chatgpt.site',workerOrigin='https://iptv.example.workers.dev';
const paths=['/api/migration-export/list','/api/migration-export/list?cursor=abc','/api/migration-export/head?key=a&etag=e&version=v','/api/migration-export/object?key=a&etag=e&version=v','/api/migration-export/manifest'];

// 3. GET and HEAD, from the old Site's origin with the key, and from the Worker's own origin.
for(const origin of [oldOrigin,workerOrigin])for(const p of paths)for(const method of ['GET','HEAD']){
 const response=await worker.fetch(new Request(origin+p,{method,headers:keyHeaders}),env,{waitUntil(){}});
 assert.equal(response.status,404,`${method} ${origin}${p}`);
 if(method==='GET')assert.deepEqual(await response.json(),{error:'Not found'},`${origin}${p}`);
}

// 4. POST and PUT: the same origin falls through to 404; a foreign Origin header is refused by the dispatcher with 403. No bucket call either way.
for(const method of ['POST','PUT']){
 const same=await worker.fetch(new Request(workerOrigin+paths[0],{method,headers:{...keyHeaders,Origin:workerOrigin},body:'{}'}),env,{waitUntil(){}});
 assert.equal(same.status,404,`${method} same origin`);
 const foreign=await worker.fetch(new Request(workerOrigin+paths[0],{method,headers:{...keyHeaders,Origin:oldOrigin},body:'{}'}),env,{waitUntil(){}});
 assert.equal(foreign.status,403,`${method} foreign origin`);
}

assert.deepEqual(calls,[],'no call on the bucket for any retired path');
console.log('Retired migration-export route: absent from the built Worker; the old origin, flags and key get 404 on GET, HEAD, POST and PUT, a foreign Origin gets 403, and the bucket is never touched');
