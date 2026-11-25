// AIR-602 / ADR 0222: the dormant offline import / parity / rollback mechanism of the Letterboxd import coordination documents (`src/letterboxd-admission-documents-import.js`), on the real migrations (a sqlite D1
// stand-in), the real Ratings store and the real marker module. No network, no production copy, no Task.
// Covered: the inventory is bounded and read-only and ignores the registry projection and the ZIP/HTML evidence; the plan is pure, deterministic and BLOCKS on an unparseable, oversized or unknown document and on a
// truncated listing; the import runs only under `closed`, writes the documents and the COMPLETE manifest LAST (a partial import leaves no manifest, so the d1 readers fail closed), is idempotent (a resend skips what
// matches), never overwrites a diverged document, and an empty cohort still ends with a manifest (missing is not empty); parity detects a late R2 writer (a changed etag, a new or a removed key) and every D1 difference;
// the rollback works before the flip and is refused after it; the module is dormant (nothing bundles or imports it).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';
import * as RatingsD1 from '../src/ratings-d1.js';
import * as LetterboxdAdmissionAuthority from '../src/letterboxd-admission-authority.js';
import * as Importer from '../src/letterboxd-admission-documents-import.js';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';

const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-admission-import-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const template=path.join(root,'template.sqlite');
sqlite(template,files.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
const STAMP='2026-11-26T10:00:00.000Z';
let copies=0;
const fresh=mode=>{
 const file=path.join(root,'c-'+(copies++)+'.sqlite');fs.copyFileSync(template,file);
 sqlite(file,"UPDATE ratings_domain_authority SET mode='d1', cutover='open', generation=3;");
 if(mode==='closed'||mode==='d1')sqlite(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1");
 if(mode==='d1')sqlite(file,"UPDATE letterboxd_admission_authority SET mode='d1',generation=2,activated_at='"+STAMP+"'");
 return file;
};
const flip=file=>sqlite(file,"UPDATE letterboxd_admission_authority SET mode='d1',generation=2,activated_at='"+STAMP+"'");
const sha256=text=>createHash('sha256').update(text).digest('hex');
const SHA='a'.repeat(64),SHB='b'.repeat(64);
const K1='letterboxd/imports/'+SHA+'/rated-candidates.json',K2='letterboxd/imports/'+SHB+'/rated-candidates.json',K3='letterboxd/imports/'+SHA+'/chunks/0.receipt.json',K4='letterboxd/imports/'+SHA+'/chunks/0.intent.json';
const REGISTRY='letterboxd/imports/registry.json',ZIP='letterboxd/imports/'+SHA+'/archive.zip';
const D1=file=>({DB:d1Standin(file)});
const J=value=>JSON.parse(JSON.stringify(value));
// the Ratings store wraps a failed batch as `ratings_domain_unavailable` with the cause attached
const killedBy=error=>/killed/.test(String(error?.message))||/killed/.test(String(error?.cause?.message));
const code=expected=>error=>{assert.equal(error.code,expected,String(error?.stack||error));return true;};
const getDoc=(file,key)=>{const found=rows(file,"SELECT body FROM ratings_document WHERE key='"+key+"' ORDER BY part");return found.length?JSON.parse(found.map(row=>row.body).join('')):null;};

// a read-only R2 stand-in with list pages and etags; `put` exists only so a test can model a late writer
const makeBucket=(initial,{pageSize=2}={})=>{
 const map=new Map(Object.entries(initial).map(([key,text],index)=>[key,{text,etag:'e'+index}]));let rev=100;
 return {map,
  put(key,text){map.set(key,{text,etag:'e'+(++rev)});},drop(key){map.delete(key);},
  async list({prefix,limit,cursor}={}){const keys=[...map.keys()].filter(key=>key.startsWith(prefix)).sort();const from=cursor?Number(cursor):0;const slice=keys.slice(from,from+Math.min(limit||pageSize,pageSize));const next=from+slice.length;return {objects:slice.map(key=>({key})),truncated:next<keys.length,cursor:String(next)};},
  async get(key){const item=map.get(key);return item?{etag:item.etag,text:async()=>item.text}:null;},
 };
};
const cohort=()=>({[K1]:JSON.stringify({schemaVersion:1,archiveSha256:SHA,candidates:{c1:{state:'verified'}}}),[K2]:JSON.stringify({schemaVersion:1,archiveSha256:SHB,candidates:{}}),[K3]:JSON.stringify({schemaVersion:1,chunk:0}),[K4]:JSON.stringify({schemaVersion:1,itemsHash:'h'}),[REGISTRY]:JSON.stringify({archives:{}}),[ZIP]:'PK-binary-ignored'});

// ===== 1. inventory and plan =====
const bucket=makeBucket(cohort());
const snapshot=await Importer.inventory(bucket);
assert.deepEqual(snapshot.documents.map(item=>item.key),[K1,K3,K4,K2].sort(),'only the moved families, sorted, across several list pages');
assert.equal(snapshot.ignored,2,'the registry projection and the ZIP are counted and never read');
assert.equal(snapshot.truncated,false);
const plan=Importer.planImport(snapshot);
assert.deepEqual(plan.blocked,[]);
assert.equal(plan.manifest.count,4);assert.equal(plan.manifest.complete,true);
assert.equal(Importer.planImport(await Importer.inventory(makeBucket(cohort()))).manifestSha256,plan.manifestSha256,'deterministic: the same cohort prints the same digest');
{
 const bad=makeBucket({...cohort(),['letterboxd/imports/'+SHB+'/chunks/1.receipt.json']:'{not json',['letterboxd/imports/'+SHB+'/chunks/2.receipt.json']:JSON.stringify({pad:'x'.repeat(RatingsD1.ADMISSION_DOCUMENT_BYTES)}),['letterboxd/imports/'+SHB+'/chunks/3.receipt.json']:'[1]'});
 const blocked=Importer.planImport(await Importer.inventory(bad));
 assert.deepEqual(blocked.blocked.map(item=>item.reason).sort(),['not_an_object','oversized','unparseable']);
 assert.equal(blocked.manifest,null,'a blocked plan has no manifest');
 await assert.rejects(()=>Importer.importDocuments(D1(fresh('closed')),blocked),code('import_blocked'));
 const many=Object.fromEntries(Array.from({length:Importer.MAX_KEYS+1},(_,i)=>['letterboxd/imports/z/'+i,'x']));
 const truncated=await Importer.inventory(makeBucket(many,{pageSize:1000}));
 assert.equal(truncated.truncated,true);assert.equal(Importer.planImport(truncated).blocked[0].reason,'inventory_truncated','a capped listing is never a complete cohort');
}

// ===== 2. the import: closed only, documents first, the complete manifest last, idempotent =====
{
 for(const mode of ['r2','d1'])await assert.rejects(()=>Importer.importDocuments(D1(fresh(mode)),plan),code('import_requires_closed'),mode+': no import');
 const f=fresh('closed'),env=D1(f);
 // a partial import (the process dies after two documents): no manifest, so the d1 readers fail closed
 let batches=0;
 const dying={DB:d1Standin(f,{onBatch:async()=>{batches++;if(batches>2)throw new Error('killed');}})};
 await assert.rejects(()=>Importer.importDocuments(dying,plan),killedBy);
 assert.equal(getDoc(f,'letterboxd/imports/documents-manifest.json'),null,'no manifest after a partial import');
 assert.equal(rows(f,"SELECT COUNT(DISTINCT key) AS n FROM ratings_document WHERE key LIKE 'letterboxd/imports/%'")[0].n,2);
 // resume from the same plan: the two documents are skipped, the rest imported, the manifest written last
 const done=await Importer.importDocuments(env,plan);
 assert.deepEqual([done.imported,done.skipped,done.manifest],[2,2,'written']);
 const again=await Importer.importDocuments(env,plan);
 assert.deepEqual([again.imported,again.skipped,again.manifest],[0,4,'present'],'idempotent: a resend writes nothing');
 assert.deepEqual(getDoc(f,K1),JSON.parse(cohort()[K1]));
 // after the flip a d1 reader sees the documents, an absent key is absent, and the registry projection is not a document
 flip(f);
 const ctx=vm.createContext({RatingsD1,LetterboxdAdmissionAuthority,JSON,Object,Number,Promise,Error,Date,Map,Set,structuredClone});
 vm.runInContext(scoped('src/letterboxd-admission-documents.js','LetterboxdAdmissionDocuments'),ctx);
 const Docs=vm.runInContext('LetterboxdAdmissionDocuments',ctx);
 assert.equal(J(await Docs.readDocument(env,K2)).value.archiveSha256,SHB);
 assert.equal((await Docs.readDocument(env,'letterboxd/imports/'+SHB+'/chunks/9.receipt.json')).value,null,'after a complete import an absent document is absent');
 // a partial import followed by the flip: fail closed
 const p=fresh('closed');
 await assert.rejects(()=>Importer.importDocuments({DB:d1Standin(p,{onBatch:async()=>{if(++batches>4)throw new Error('killed');}})},plan),killedBy);
 flip(p);
 await assert.rejects(()=>Docs.readDocument(D1(p),K1),code('admission_documents_not_imported'),'a partial import never reads as empty');
}

// ===== 3. a diverged document is never overwritten; an empty cohort still ends with a manifest =====
{
 const f=fresh('closed'),env=D1(f);
 await Importer.importDocuments(env,plan);
 const changed=Importer.planImport(await Importer.inventory(makeBucket({...cohort(),[K1]:JSON.stringify({schemaVersion:1,archiveSha256:SHA,candidates:{c1:{state:'needs_review'}}})})));
 await assert.rejects(()=>Importer.importDocuments(env,changed),code('diverged'),'another cohort over a completed import');
 assert.equal(getDoc(f,K1).candidates.c1.state,'verified','the D1 copy was not overwritten');
 const g=fresh('closed');
 sqlite(g,"INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES ('"+K1+"',0,'"+JSON.stringify({other:true})+"','"+sha256(JSON.stringify({other:true}))+"','"+STAMP+"')");
 await assert.rejects(()=>Importer.importDocuments(D1(g),plan),code('diverged'),'a D1 document that is not the plan');
 assert.equal(getDoc(g,'letterboxd/imports/documents-manifest.json'),null,'no manifest after a diverged stop');
 const empty=Importer.planImport(await Importer.inventory(makeBucket({[REGISTRY]:'{}'})));
 const h=fresh('closed');
 assert.deepEqual(J(await Importer.importDocuments(D1(h),empty)),{imported:0,skipped:0,manifest:'written'});
 assert.equal(getDoc(h,'letterboxd/imports/documents-manifest.json').count,0,'missing is not empty: the manifest records zero documents');
}

// ===== 4. parity: a late R2 writer and every D1 difference =====
{
 const live=makeBucket(cohort()),snap=Importer.planImport(await Importer.inventory(live));
 const f=fresh('closed'),env=D1(f);
 await Importer.importDocuments(env,snap);
 assert.deepEqual(J(await Importer.verifyParity(env,snap,live)),{equal:true,differences:[]});
 live.put(K1,JSON.stringify({schemaVersion:1,archiveSha256:SHA,candidates:{c1:{state:'verified'},c2:{}}}));
 assert.deepEqual((await Importer.verifyParity(env,snap,live)).differences.map(item=>[item.key,item.kind]),[[K1,'r2_drift']],'a late PUT after the snapshot');
 live.drop(K3);
 assert.ok((await Importer.verifyParity(env,snap,live)).differences.some(item=>item.key===K3&&item.kind==='r2_drift'),'a removed key');
 live.put('letterboxd/imports/'+SHB+'/chunks/7.receipt.json','{"late":true}');
 assert.ok((await Importer.verifyParity(env,snap,live)).differences.some(item=>item.key.endsWith('7.receipt.json')&&item.kind==='r2_drift'),'a new key');
 const clean=makeBucket(cohort()),again=Importer.planImport(await Importer.inventory(clean));
 const g=fresh('closed');await Importer.importDocuments(D1(g),again);
 sqlite(g,"DELETE FROM ratings_document WHERE key='"+K4+"'");
 sqlite(g,"UPDATE ratings_document SET body='{\"schemaVersion\":1,\"chunk\":9}',etag='"+sha256('{"schemaVersion":1,"chunk":9}')+"' WHERE key='"+K3+"'");
 sqlite(g,"INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES ('letterboxd/imports/"+SHB+"/chunks/5.receipt.json',0,'{}','"+sha256('{}')+"','"+STAMP+"')");
 const kinds=(await Importer.verifyParity(D1(g),again,clean)).differences.map(item=>item.kind).sort();
 assert.deepEqual(kinds,['d1_extra','missing_in_d1'].sort().concat(['d1_differs']).sort(),'a deleted, an altered and an extra D1 document');
 const h=fresh('closed');
 assert.deepEqual((await Importer.verifyParity(D1(h),again,clean)).differences.filter(item=>item.kind==='manifest_missing').length,1,'no manifest');
}

// ===== 5. rollback: before the flip it removes the D1 copies (R2 is untouched); after the flip it is refused =====
{
 const f=fresh('closed'),env=D1(f);
 await Importer.importDocuments(env,plan);
 assert.deepEqual(J(await Importer.rollbackImport(env)),{rolledBack:true});
 assert.equal(rows(f,"SELECT COUNT(*) AS n FROM ratings_document WHERE key LIKE 'letterboxd/imports/%'")[0].n,0,'documents and manifest are gone');
 assert.deepEqual(J(await Importer.importDocuments(env,plan)).manifest,'written','a rolled-back run imports again');
 flip(f);
 await assert.rejects(()=>Importer.rollbackImport(env),code('rollback_after_flip'));
 assert.equal(rows(f,"SELECT COUNT(*) AS n FROM ratings_document WHERE key LIKE 'letterboxd/imports/%'")[0].n,5,'after the flip nothing is deleted');
 // a rollback of a run that raced with the flip: the batch asserts the marker (a stand-in flips right before the batch)
 const g=fresh('closed');await Importer.importDocuments(D1(g),plan);
 let flipped=false;
 await assert.rejects(()=>Importer.rollbackImport({DB:d1Standin(g,{onBatch:async()=>{if(!flipped){flipped=true;flip(g);}}})}));
 assert.equal(rows(g,"SELECT COUNT(*) AS n FROM ratings_document WHERE key LIKE 'letterboxd/imports/%'")[0].n,5,'a flip between the read and the batch refuses the rollback whole');
}

// ===== 6. dormant: nothing bundles or imports the importer =====
{
 const sources=fs.readdirSync('src',{recursive:true}).filter(name=>String(name).endsWith('.js')).map(name=>path.join('src',String(name)));
 const importers=sources.filter(name=>/letterboxd-admission-documents-import/.test(fs.readFileSync(name,'utf8')));
 assert.deepEqual(importers,[],'no module imports it');
 for(const file of ['build.mjs','scripts/bundle-scope.mjs','src/worker.js'])assert.ok(!/letterboxd-admission-documents-import/.test(fs.readFileSync(file,'utf8')),file+' does not bundle it');
}

console.log('Letterboxd admission documents import (AIR-602, ADR 0222): inventory, plan, closed-only import, manifest last, parity, rollback, dormancy passed.');
