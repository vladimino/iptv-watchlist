// AIR-602 / ADR 0222 (PR #1018 review): the READ-ONLY owner readers at marker `d1` over the REAL adapter, the REAL Ratings store and a sqlite D1 stand-in, with an R2 bucket that fails the test on any call:
// the archive status readers (`lbaRatingsRead`, `lbaRead`, `lbaVersion` of src/admin/letterboxd-archive.js) and the identity-work inventory readers (`identityWorkReadRegistry`, `identityWorkListArchives`,
// `identityWorkReadDocument` of src/admin/identity-work.js). The functions are taken from the sources as text. Covered: at `d1` they answer from D1 only (no R2 get, head or list: no R2 authority, no registry projection);
// a missing or partial manifest and an unreadable marker are unavailable (never the R2 copy and never "empty"); under `closed` the quiescent R2 objects are still the record; at `r2` nothing changes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createHash,webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';
import * as RatingsD1 from '../src/ratings-d1.js';
import * as LetterboxdAdmissionAuthority from '../src/letterboxd-admission-authority.js';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';

const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-archive-readers-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<27});if(r.status!==0)throw new Error(r.stderr);};
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const template=path.join(root,'template.sqlite');
sqlite(template,files.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
const STAMP='2026-11-26T10:00:00.000Z';
const q=text=>"'"+String(text).replace(/'/g,"''")+"'";
const sha256=text=>createHash('sha256').update(text).digest('hex');
let copies=0;
const setDoc=(file,key,value)=>{const body=typeof value==='string'?value:JSON.stringify(value);sqlite(file,'DELETE FROM ratings_document WHERE key='+q(key)+';INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES ('+q(key)+',0,'+q(body)+','+q(sha256(body))+','+q(STAMP)+')');};
const MANIFEST='letterboxd/imports/documents-manifest.json';
const manifest=keys=>({schemaVersion:1,complete:true,count:keys.length,keys,inventorySha256:sha256(JSON.stringify(keys))});
const fresh=(mode,{withManifest=true}={})=>{
 const file=path.join(root,'c-'+(copies++)+'.sqlite');fs.copyFileSync(template,file);
 sqlite(file,"UPDATE ratings_domain_authority SET mode='d1', cutover='open', generation=3;");
 if(mode==='closed'||mode==='d1')sqlite(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1");
 if(mode==='d1')sqlite(file,"UPDATE letterboxd_admission_authority SET mode='d1',generation=2,activated_at='"+STAMP+"'");
 if(mode==='d1'&&withManifest)setDoc(file,MANIFEST,manifest([]));
 return file;
};
const SHA='a'.repeat(64),SHB='b'.repeat(64);
const CAND=sha=>'letterboxd/imports/'+sha+'/rated-candidates.json',RECEIPT='letterboxd/imports/'+SHA+'/chunks/0.receipt.json';
const calls=[];
const r2=new Map();
const bucket={
 async get(key){calls.push(['get',key]);return r2.has(key)?{etag:'r2e',size:String(JSON.stringify(r2.get(key))).length,body:{cancel:async()=>{}},json:async()=>structuredClone(r2.get(key)),text:async()=>JSON.stringify(r2.get(key))}:null;},
 async head(key){calls.push(['head',key]);return r2.has(key)?{etag:'r2e',size:100}:null;},
 async list(options){calls.push(['list',options.prefix]);return {objects:[],delimitedPrefixes:[],truncated:false};},
};

const take=(source,name)=>{const head='^(?:async )?function '+name+'\\(';const match=new RegExp(head+'[^\\n]*\\}$','m').exec(source)||new RegExp(head+'.*?^}','ms').exec(source);assert.ok(match,name+' exists');return match[0];};
const archiveSource=fs.readFileSync('src/admin/letterboxd-archive.js','utf8'),workSource=fs.readFileSync('src/admin/identity-work.js','utf8');
const ctx=vm.createContext({RatingsD1,LetterboxdAdmissionAuthority,JSON,Object,Number,Promise,Error,Date,Map,Set,WeakMap,structuredClone,TextEncoder,Uint8Array,crypto:webcrypto,console});
vm.runInContext(scoped('src/letterboxd-admission-documents.js','LetterboxdAdmissionDocuments'),ctx);
vm.runInContext(scoped('src/domain/letterboxd-import-registry.js','LetterboxdImportRegistry')+'\n'+scoped('src/domain/identity-work-inventory.js','IdentityWorkInventory'),ctx);
vm.runInContext(['const LBA_METADATA_KEY="enrichment/metadata.json";const lbaVersions=new WeakMap();const adminDiscardBody=async()=>{};',
 take(archiveSource,'lbaNote'),take(archiveSource,'lbaRatingsRead'),take(archiveSource,'lbaRead'),take(archiveSource,'lbaVersion'),
 take(workSource,'identityWorkAtD1'),take(workSource,'identityWorkReadRegistry'),take(workSource,'identityWorkListArchives'),take(workSource,'identityWorkReadDocument'),
 'globalThis.api={lbaRead,lbaVersion,identityWorkReadRegistry,identityWorkListArchives,identityWorkReadDocument,lbaVersions};'].join('\n'),ctx);
const api=ctx.api;
const J=value=>JSON.parse(JSON.stringify(value));
const seedD1=file=>{
 setDoc(file,CAND(SHA),{schemaVersion:1,archiveSha256:SHA,candidates:{c1:{state:'pending'}}});
 setDoc(file,CAND(SHB),{schemaVersion:1,archiveSha256:SHB,candidates:{}});
 setDoc(file,RECEIPT,{schemaVersion:1,chunk:0});
 const entry=key=>({key,etag:'e',bytes:2,sha256:sha256('{}')});
 setDoc(file,MANIFEST,manifest([entry(CAND(SHA)),entry(CAND(SHB)),entry(RECEIPT)]));
};

// ===== d1: everything is answered from D1, R2 is never touched =====
{
 const f=fresh('d1');seedD1(f);r2.set(CAND(SHA),{stale:'r2-copy'});r2.set('letterboxd/imports/registry.json',{stale:true});calls.length=0;
 const env={DB:d1Standin(f),BUCKET:bucket};
 const read=await api.lbaRead(env,RECEIPT);
 assert.deepEqual([read.evidence,read.authority,J(read.value)],['observed','d1',{schemaVersion:1,chunk:0}]);
 assert.ok(read.etag&&read.etag!=='r2e');
 const absent=await api.lbaRead(env,'letterboxd/imports/'+SHA+'/chunks/9.receipt.json');
 assert.deepEqual([absent.evidence,absent.authority,absent.value],['object_missing','d1',null],'after a complete import an absent chunk document is absent');
 assert.equal(await api.lbaVersion(env,RECEIPT),read.etag,'the version of a document is its D1 etag');
 assert.equal(await api.lbaVersion(env,'letterboxd/imports/'+SHA+'/chunks/9.receipt.json'),'absent');
 const registry=await api.identityWorkReadRegistry(env);
 assert.deepEqual([registry.state,registry.token],['absent','d1'],'the registry projection is frozen: not read as authority');
 assert.deepEqual(J(await api.identityWorkListArchives(env)),{prefixes:[SHA,SHB],truncated:false},'the archives are listed from D1');
 const whole=await api.identityWorkReadDocument(env,SHA);
 assert.deepEqual([whole.state,J(whole.doc).candidates.c1.state],['read_whole','pending'],'the document is the D1 one, not the stale R2 copy');
 const oversize=fresh('d1');setDoc(oversize,CAND(SHA),{schemaVersion:1,archiveSha256:SHA,candidates:{},pad:'x'.repeat(2*1024*1024+100)});setDoc(oversize,MANIFEST,manifest([{key:CAND(SHA),etag:'e',bytes:2,sha256:'0'}]));
 assert.equal((await api.identityWorkReadDocument({DB:d1Standin(oversize),BUCKET:bucket},SHA)).state,'oversized','the inventory keeps its own read bound');
 const wrong=fresh('d1');setDoc(wrong,CAND(SHA),{schemaVersion:1,archiveSha256:SHB,candidates:{}});
 assert.equal((await api.identityWorkReadDocument({DB:d1Standin(wrong),BUCKET:bucket},SHA)).state,'unreadable','a document of another archive is unreadable, never accepted');
 assert.deepEqual(calls,[],'no R2 get, head or list in any read at d1: no R2 authority');
}

// ===== d1 without a complete import, and an unreadable marker: unavailable, never empty, never the R2 copy =====
{
 const noManifest=fresh('d1',{withManifest:false});setDoc(noManifest,CAND(SHA),{schemaVersion:1,archiveSha256:SHA,candidates:{}});calls.length=0;
 const env={DB:d1Standin(noManifest),BUCKET:bucket};
 assert.equal((await api.lbaRead(env,RECEIPT)).evidence,'unavailable','no manifest: unavailable');
 assert.equal(await api.lbaVersion(env,RECEIPT),'unavailable');
 assert.equal((await api.identityWorkReadDocument(env,SHA)).state,'unreadable');
 assert.equal(await api.identityWorkListArchives(env),null,'the listing could not be completed: partial, never a complete list');
 const broken=fresh('d1');seedD1(broken);sqlite(broken,'DROP TABLE letterboxd_admission_authority');
 const benv={DB:d1Standin(broken),BUCKET:bucket};
 assert.equal((await api.lbaRead(benv,RECEIPT)).evidence,'unavailable');
 assert.equal(await api.lbaVersion(benv,RECEIPT),'unavailable');
 assert.equal((await api.identityWorkReadRegistry(benv)).state,'unreadable');
 assert.equal(await api.identityWorkListArchives(benv),null);
 assert.equal((await api.identityWorkReadDocument(benv,SHA)).state,'unreadable');
 // a damaged import: the manifest lists a key that is missing in D1
 const damaged=fresh('d1');setDoc(damaged,MANIFEST,manifest([{key:RECEIPT,etag:'e',bytes:2,sha256:'0'}]));
 assert.equal((await api.lbaRead({DB:d1Standin(damaged),BUCKET:bucket},RECEIPT)).evidence,'unavailable','listed but missing: unavailable, not absent');
 assert.deepEqual(calls,[],'none of them fell back to R2');
}

// ===== closed: the R2 objects are quiescent and still the record; r2: unchanged =====
for(const mode of ['closed','r2']){
 const f=fresh(mode);r2.clear();r2.set(RECEIPT,{schemaVersion:1,chunk:0,from:'r2'});r2.set(CAND(SHA),{schemaVersion:1,archiveSha256:SHA,candidates:{}});calls.length=0;
 const env={DB:d1Standin(f),BUCKET:bucket};
 const read=await api.lbaRead(env,RECEIPT);
 assert.deepEqual([read.authority,read.evidence,J(read.value).from],['r2','observed','r2'],mode+': read from R2');
 assert.equal(await api.lbaVersion(env,RECEIPT),'r2e',mode+': the R2 etag');
 const doc=await api.identityWorkReadDocument(env,SHA);
 assert.equal(doc.state,'read_whole',mode+': the inventory reads the R2 document');
 assert.ok(calls.some(call=>call[0]==='get'),mode+': R2 was read');
}

console.log('Letterboxd owner readers at d1 (AIR-602, ADR 0222): D1 only, fail closed without a complete import, R2 still the record under closed and r2 passed.');
