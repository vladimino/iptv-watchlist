// AIR-602 / ADR 0222 (owner option B on PR #1018): the Letterboxd import coordination documents (rated candidates, chunk intent / receipt / candidates result) are D1 Ratings documents ONLY at marker `d1`.
// Real migrations on a sqlite D1 stand-in, the real Ratings store and the real marker module; the adapter (`src/letterboxd-admission-documents.js`) runs in a vm with those two as its scope, as in the bundle.
// Covered: the key predicate (the moved families and the manifest only; none of them joins `ratingsMutableKey`, so no existing Ratings route changes); the route per marker mode (r2 and absent route nothing, closed and an
// unreadable marker refuse, d1 routes); a d1 document store without a COMPLETE import manifest fails closed for reads and writes (absent or partial import never reads as empty); a stale compare-and-swap retries against the
// new revision and two concurrent writers both land; a caller assertion that does not hold refuses the WHOLE batch (nothing written, `refused`), and one that holds commits with the document; a marker that moves between
// the read and the commit refuses the batch; the byte bound; the bounded archive listing.
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

const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-admission-documents-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const template=path.join(root,'template.sqlite');
sqlite(template,files.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
const STAMP='2026-11-26T10:00:00.000Z';
const sqlText=text=>"'"+String(text).replace(/'/g,"''")+"'";
let copies=0;
const fresh=(mode='d1')=>{
 const file=path.join(root,'c-'+(copies++)+'.sqlite');fs.copyFileSync(template,file);
 sqlite(file,"UPDATE ratings_domain_authority SET mode='d1', cutover='open', generation=3;");
 if(mode==='d1')sqlite(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1;UPDATE letterboxd_admission_authority SET mode='d1',generation=2,activated_at='"+STAMP+"'");
 else if(mode==='closed')sqlite(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1");
 return file;
};
const setDoc=(file,key,value)=>{const body=JSON.stringify(value);sqlite(file,'DELETE FROM ratings_document WHERE key='+sqlText(key)+';INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES ('+sqlText(key)+',0,'+sqlText(body)+','+sqlText(createHash('sha256').update(body).digest('hex'))+','+sqlText(STAMP)+')');};
const getDoc=(file,key)=>{const found=rows(file,'SELECT body FROM ratings_document WHERE key='+sqlText(key)+' ORDER BY part');return found.length?JSON.parse(found.map(row=>row.body).join('')):null;};
const SHA='a'.repeat(64),SHB='b'.repeat(64);
const sha256=text=>createHash('sha256').update(text).digest('hex');
// a complete manifest over a key list: count, keys and digest agree
const manifestOf=(keys=[])=>({schemaVersion:1,complete:true,count:keys.length,keys,inventorySha256:sha256(JSON.stringify(keys))});
const EMPTY=manifestOf();
const KEY='letterboxd/imports/'+SHA+'/rated-candidates.json',RECEIPT='letterboxd/imports/'+SHA+'/chunks/3.receipt.json',MANIFEST='letterboxd/imports/documents-manifest.json';

const ctx=vm.createContext({RatingsD1,LetterboxdAdmissionAuthority,JSON,Object,Number,Promise,Error,Date,Map,Set,structuredClone,TextEncoder,Uint8Array,crypto:webcrypto});
vm.runInContext(scoped('src/letterboxd-admission-documents.js','LetterboxdAdmissionDocuments'),ctx);
const Docs=vm.runInContext('LetterboxdAdmissionDocuments',ctx);
// the adapter runs in a vm: compare its results through JSON (cross-realm deepStrictEqual)
const J=value=>JSON.parse(JSON.stringify(value));
const code=expected=>error=>{assert.equal(error.code,expected,String(error?.stack||error));return true;};

// ===== 1. keys: the moved families and the manifest, nothing else; none joins the general Ratings routes =====
{
 const moved=[KEY,RECEIPT,'letterboxd/imports/'+SHA+'/chunks/0.intent.json','letterboxd/imports/'+SHA+'/chunks/12.candidates.json',MANIFEST];
 for(const key of moved){assert.equal(RatingsD1.admissionDocumentKey(key),true,key);assert.equal(RatingsD1.ratingsMutableKey(key),false,'not a general Ratings key: '+key);assert.equal(Docs.isAdmissionDocumentKey(key),true);}
 for(const key of ['letterboxd/imports/registry.json','letterboxd/imports/'+SHA+'/chunks/3.zip','letterboxd/imports/'+SHA+'/archive.zip','letterboxd/imports/'+SHA+'/chunks/x.receipt.json','letterboxd/imports/short/rated-candidates.json','letterboxd/admissions/verified-films.json','admin/actions/letterboxd_archive_apply/v1/k.json','letterboxd/imports/'+SHA+'/../rated-candidates.json'])
  assert.equal(RatingsD1.admissionDocumentKey(key),false,key);
 // a moved key is invisible to the general routes: without the explicit option nothing is owned
 const f=fresh();setDoc(f,KEY,{x:1});
 assert.deepEqual(await RatingsD1.readOwned({DB:d1Standin(f)},KEY),{owned:false});
 assert.equal((await RatingsD1.readOwned({DB:d1Standin(f)},KEY,{admission:true})).owned,true);
 assert.deepEqual(await RatingsD1.casOwned({DB:d1Standin(f)},KEY,{},d=>d),{owned:false});
}

// ===== 2. the route per marker mode =====
{
 const absent=path.join(root,'absent.sqlite');
 sqlite(absent,files.slice(0,files.indexOf('0045_letterboxd_admission_authority.sql')).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
 assert.deepEqual((await Docs.documentRoute({DB:d1Standin(absent)},KEY)).d1,false,'migration absent: nothing is routed');
 assert.deepEqual((await Docs.documentRoute({},KEY)).d1,false,'no D1 binding: the legacy R2 path');
 assert.equal((await Docs.documentRoute({DB:d1Standin(fresh('r2'))},KEY)).d1,false,'r2: nothing is routed');
 assert.equal((await Docs.documentRoute({DB:d1Standin(fresh('r2'))},'letterboxd/imports/registry.json')).d1,false,'a key that is not a moved document is never routed');
 await assert.rejects(()=>Docs.documentRoute({DB:d1Standin(fresh('closed'))},KEY),code('letterboxd_admission_closed'));
 assert.equal((await Docs.documentRoute({DB:d1Standin(fresh('d1'))},KEY)).d1,true,'d1: routed');
 // schema version 45 with the marker table gone: unreadable, never read as `r2`
 const broken=fresh('d1');sqlite(broken,'DROP TABLE letterboxd_admission_authority');
 await assert.rejects(()=>Docs.documentRoute({DB:d1Standin(broken)},KEY),error=>/unavailable/.test(String(error.code)),'an unreadable marker is unavailable, never legacy');
}

// ===== 3. a d1 document store without a COMPLETE manifest fails closed: absent or partial never reads as empty =====
{
 const f=fresh(),env={DB:d1Standin(f)};
 await assert.rejects(()=>Docs.readDocument(env,KEY),code('admission_documents_not_imported'),'no manifest');
 await assert.rejects(()=>Docs.casDocument(env,KEY,{},d=>({...d,a:1})),code('admission_documents_not_imported'),'no manifest: no write either');
 assert.equal(getDoc(f,KEY),null,'nothing written');
 setDoc(f,MANIFEST,{schemaVersion:1,complete:false});
 await assert.rejects(()=>Docs.readDocument(env,KEY),code('admission_documents_not_imported'),'a partial import');
 setDoc(f,MANIFEST,{schemaVersion:2,complete:true});
 await assert.rejects(()=>Docs.readDocument(env,KEY),code('admission_documents_not_imported'),'an unknown manifest schema');
 setDoc(f,MANIFEST,EMPTY);
 assert.deepEqual(J(await Docs.readDocument(env,KEY)),{value:null,etag:null},'after a complete import an absent document is absent');
 // PR #1018 review: the manifest is validated for consistency, and a key it lists that is missing is a damaged import, never new
 const entry=key=>({key,etag:'e',bytes:2,sha256:sha256('{}')});
 for(const [label,bad] of [
  ['a count that disagrees',{...EMPTY,count:1}],
  ['a digest that disagrees',{...EMPTY,inventorySha256:'0'.repeat(64)}],
  ['no key list',{schemaVersion:1,complete:true,count:0,inventorySha256:sha256('[]')}],
  ['a duplicate key',manifestOf([entry(KEY),entry(KEY)])],
  ['the manifest itself listed',manifestOf([entry(MANIFEST)])],
  ['a key that is not a moved document',manifestOf([entry('letterboxd/imports/registry.json')])],
 ]){
  setDoc(f,MANIFEST,bad);
  await assert.rejects(()=>Docs.readDocument(env,KEY),code('admission_documents_inconsistent'),label);
  await assert.rejects(()=>Docs.casDocument(env,KEY,{},d=>({...d,x:1})),code('admission_documents_inconsistent'),label+': no write');
 }
 assert.equal(getDoc(f,KEY),null,'nothing written under an inconsistent manifest');
 setDoc(f,MANIFEST,manifestOf([entry(KEY)]));
 await assert.rejects(()=>Docs.readDocument(env,KEY),code('admission_document_missing'),'listed by the import but missing in D1');
 await assert.rejects(()=>Docs.casDocument(env,KEY,{},d=>({...d,x:1})),code('admission_document_missing'),'and it is never recreated as a new document');
 assert.equal(getDoc(f,KEY),null);
 assert.deepEqual(J(await Docs.readDocument(env,RECEIPT)),{value:null,etag:null},'a key the import did not list is genuinely absent');
 const created=await Docs.casDocument(env,RECEIPT,{},d=>({...d,sealed:true}));
 assert.equal(created.changed,true,'and a genuinely new post-cutover key can be created');
 setDoc(f,KEY,{archiveSha256:SHA});
 assert.equal((await Docs.readDocument(env,KEY)).value.archiveSha256,SHA,'the listed key present: read');
}

// ===== 4. writes: create, update, a stale revision retries, two concurrent writers both land =====
{
 const f=fresh(),env={DB:d1Standin(f)};setDoc(f,MANIFEST,EMPTY);
 const made=await Docs.casDocument(env,KEY,{n:0},d=>({...d,n:d.n+1}));
 assert.deepEqual([made.changed,made.value.n],[true,1]);
 assert.deepEqual(getDoc(f,KEY),{n:1});
 const unchanged=await Docs.casDocument(env,KEY,{n:0},()=>null);
 assert.deepEqual([unchanged.changed,unchanged.value.n],[false,1],'null from apply is no write');
 // two concurrent writers: each applies to the revision it read; the loser retries against the winner's revision
 const both=await Promise.all([1,2,3,4].map(i=>Docs.casDocument(env,KEY,{n:0},d=>({...d,n:d.n+1,['k'+i]:true}))));
 assert.ok(both.every(item=>item.changed===true));
 const end=getDoc(f,KEY);
 assert.equal(end.n,5,'every writer landed on a distinct revision');
 assert.deepEqual([end.k1,end.k2,end.k3,end.k4],[true,true,true,true]);
 assert.equal(rows(f,'SELECT COUNT(DISTINCT etag) AS n FROM ratings_document WHERE key='+sqlText(KEY))[0].n,1,'one etag at the end (never mixed parts)');
}

// ===== 5. a caller assertion: false refuses the WHOLE batch; true commits with the document =====
{
 const f=fresh(),env={DB:d1Standin(f)};setDoc(f,MANIFEST,EMPTY);
 setDoc(f,RECEIPT,{state:'open'});
 const FALSE=['UPDATE ratings_domain_cas SET ok=CASE WHEN 0 THEN 1 ELSE 0 END WHERE id=1',[]];
 const TRUE=['UPDATE ratings_domain_cas SET ok=CASE WHEN 1 THEN 1 ELSE 0 END WHERE id=1',[]];
 const before=getDoc(f,RECEIPT);
 const refused=await Docs.casDocument(env,RECEIPT,{},d=>({...d,state:'sealed'}),{extra:[FALSE]});
 assert.deepEqual(J(refused),{refused:true},'a history assertion that does not hold refuses the batch');
 assert.deepEqual(getDoc(f,RECEIPT),before,'nothing written');
 const generationBefore=rows(f,'SELECT generation FROM ratings_domain_authority')[0].generation;
 assert.equal(generationBefore,3,'a refused batch does not bump the Ratings generation');
 const ok=await Docs.casDocument(env,RECEIPT,{},d=>({...d,state:'sealed'}),{extra:[TRUE]});
 assert.deepEqual([ok.changed,ok.value.state],[true,'sealed']);
 assert.equal(rows(f,'SELECT generation FROM ratings_domain_authority')[0].generation,4);
}

// ===== 6. the d1 assertion of the batch: the marker row is one-way (`d1` never changes mode or generation), so the assertion refuses a batch planned from any other read, and `closed` refuses before any write =====
{
 const f=fresh(),setup={DB:d1Standin(f)};setDoc(f,MANIFEST,EMPTY);
 setDoc(f,KEY,{n:1});
 const authority=(await Docs.documentRoute(setup,KEY)).authority;
 // a plan made from a read that is not the row now (an older generation) is refused by the batch's own assertion
 const stale=await Docs.casDocument(setup,KEY,{n:0},d=>({...d,n:2}),{authority:{...authority,generation:authority.generation-1}});
 assert.deepEqual(J(stale),{refused:true},'a batch planned from another generation is refused whole');
 assert.deepEqual(getDoc(f,KEY),{n:1},'nothing is written');
 assert.throws(()=>sqlite(f,"UPDATE letterboxd_admission_authority SET generation=generation+1"),/chain/,'the d1 row cannot move: a refused batch can only come from a plan made elsewhere');
 const fresh1=await Docs.casDocument(setup,KEY,{n:0},d=>({...d,n:3}));
 assert.deepEqual([fresh1.changed,getDoc(f,KEY).n],[true,3],'a caller that reads the marker itself lands');
 // under `closed` (the pre-flip state of the same marker) the adapter refuses before any write
 const closed=fresh('closed');setDoc(closed,MANIFEST,EMPTY);
 await assert.rejects(()=>Docs.casDocument({DB:d1Standin(closed)},KEY,{},d=>({...d,n:1})),code('letterboxd_admission_closed'));
 assert.equal(getDoc(closed,KEY),null);
}

// ===== 7. the byte bound and the bounded listing =====
{
 const f=fresh(),env={DB:d1Standin(f)};setDoc(f,MANIFEST,EMPTY);
 await assert.rejects(()=>Docs.casDocument(env,KEY,{},()=>({big:'x'.repeat(RatingsD1.ADMISSION_DOCUMENT_BYTES+1)})),code('admission_document_too_large'));
 assert.equal(getDoc(f,KEY),null,'nothing written');
 setDoc(f,KEY,{archiveSha256:SHA});setDoc(f,'letterboxd/imports/'+SHB+'/rated-candidates.json',{archiveSha256:SHB});setDoc(f,RECEIPT,{x:1});
 assert.deepEqual(J(await Docs.listCandidateArchives(env,10)),{shas:[SHA,SHB],truncated:false},'one key per archive, receipts and the manifest are not archives');
 assert.deepEqual(J(await Docs.listCandidateArchives(env,1)),{shas:[SHA],truncated:true},'truncated is partial, never a complete listing');
 const bare=fresh();await assert.rejects(()=>Docs.listCandidateArchives({DB:d1Standin(bare)},10),code('admission_documents_not_imported'));
}

console.log('Letterboxd admission documents (AIR-602, ADR 0222): keys, routes, fail-closed manifest, atomic refusal, bounds passed.');
