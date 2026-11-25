// AIR-602 / ADR 0222: the owner archive apply's candidates chunk result and its chunk reads at marker `d1`. The two functions under test (`lbaObject`, `lbaCommitCandidates`, with their small helpers) are taken
// from src/admin/letterboxd-archive-apply.js as text and run in a vm over the REAL adapter, the REAL Ratings store and a sqlite D1 stand-in; the registration of the candidates is a recording stub.
// Covered: at `d1` the write-once result is a D1 document (no R2 put), a second commit of the same plan is a replay, another plan is `chunk_conflict`, a read answers from D1, a closed or unreadable marker is
// unavailable storage (never the R2 copy), and at `r2` the delivered R2 path is unchanged (an etagDoesNotMatch put).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';
import * as RatingsD1 from '../src/ratings-d1.js';
import * as LetterboxdAdmissionAuthority from '../src/letterboxd-admission-authority.js';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';

const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-archive-apply-d1-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const template=path.join(root,'template.sqlite');
sqlite(template,files.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
const STAMP='2026-11-26T10:00:00.000Z';
const q=text=>"'"+String(text).replace(/'/g,"''")+"'";
let copies=0;
const fresh=mode=>{
 const file=path.join(root,'c-'+(copies++)+'.sqlite');fs.copyFileSync(template,file);
 sqlite(file,"UPDATE ratings_domain_authority SET mode='d1', cutover='open', generation=3;");
 if(mode==='closed'||mode==='d1')sqlite(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1");
 if(mode==='d1'){sqlite(file,"UPDATE letterboxd_admission_authority SET mode='d1',generation=2,activated_at='"+STAMP+"'");const body=JSON.stringify({schemaVersion:1,complete:true});sqlite(file,'INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES ('+q('letterboxd/imports/documents-manifest.json')+',0,'+q(body)+','+q(createHash('sha256').update(body).digest('hex'))+','+q(STAMP)+')');}
 return file;
};
const getDoc=(file,key)=>{const found=rows(file,'SELECT body FROM ratings_document WHERE key='+q(key)+' ORDER BY part');return found.length?JSON.parse(found.map(row=>row.body).join('')):null;};

const source=fs.readFileSync('src/admin/letterboxd-archive-apply.js','utf8');
const take=(kind,name)=>{const head='^'+(kind==='async'?'async ':'')+'function '+name+'\\(';const match=new RegExp(head+'[^\\n]*\\}$','m').exec(source)||new RegExp(head+'.*?^}','ms').exec(source);assert.ok(match,name+' exists');return match[0];};
class FactsError extends Error{constructor(code,message){super(message);this.code=code;}}
const registered=[];
const puts=[];const r2=new Map();
const ctx=vm.createContext({RatingsD1,LetterboxdAdmissionAuthority,JSON,Object,Number,Promise,Error,Date,Map,Set,structuredClone,
 LetterboxdFacts:{FactsError},LetterboxdRatedCandidates:{registerCandidates:async (_env,input)=>{registered.push(input);return {added:input.rows.map(row=>row.code),kept:[]};}}});
vm.runInContext(scoped('src/letterboxd-admission-documents.js','LetterboxdAdmissionDocuments'),ctx);
vm.runInContext([take('sync','lbaImportObject'),take('async','lbaObject'),take('sync','lbaCandidateEntries'),take('async','lbaCommitCandidates'),'globalThis.api={lbaObject,lbaCommitCandidates,lbaImportObject};'].join('\n'),ctx);
const api=ctx.api;
const SHA='a'.repeat(64);
const origin={sha256:SHA,generatedAt:'2026-11-20T10:00:00.000Z'};
const plan=(hash,codes)=>({planHash:hash,batch:{rows:codes.map(code=>({code}))}});
const bucket={
 async get(key){return r2.has(key)?{etag:'e',json:async()=>structuredClone(r2.get(key))}:null;},
 async put(key,value,options={}){if(options.onlyIf?.etagDoesNotMatch==='*'&&r2.has(key))return null;r2.set(key,JSON.parse(value));puts.push(key);return {etag:'e'};},
};
const code=expected=>error=>{assert.equal(error.code,expected,String(error?.stack||error));return true;};
const KEY=api.lbaImportObject(SHA,4,'candidates');

// ===== d1: the write-once result is a D1 document, replayed by the same plan, refused for another =====
{
 const f=fresh('d1'),env={DB:d1Standin(f),BUCKET:bucket};
 const first=await api.lbaCommitCandidates(env,origin,4,plan('h1',['x1','x2']));
 assert.equal(first.replay,false);assert.deepEqual(JSON.parse(JSON.stringify(first.outcomes)),{registered:2,kept:0});
 assert.deepEqual(puts,[],'no R2 put at d1');
 const stored=getDoc(f,KEY);
 assert.deepEqual([stored.kind,stored.itemsHash,stored.chunk,stored.codes],['candidates','h1',4,['x1','x2']]);
 const replay=await api.lbaCommitCandidates(env,origin,4,plan('h1',['x1','x2']));
 assert.equal(replay.replay,true,'the same plan is a replay');
 assert.equal(registered.length,1,'a replay registers nothing');
 await assert.rejects(()=>api.lbaCommitCandidates(env,origin,4,plan('h2',['x9'])),code('chunk_conflict'));
 assert.equal(getDoc(f,KEY).itemsHash,'h1','the stored result was not overwritten');
 // reads answer from D1
 assert.equal((await api.lbaObject(env,KEY)).value.itemsHash,'h1');
 assert.equal((await api.lbaObject(env,api.lbaImportObject(SHA,9,'receipt'))).value,null,'absent after a complete import');
 // a stale R2 copy is never read at d1
 r2.set(api.lbaImportObject(SHA,7,'receipt'),{stale:true});
 assert.equal((await api.lbaObject(env,api.lbaImportObject(SHA,7,'receipt'))).value,null,'no R2 fallback');
}

// ===== closed and an unreadable marker: unavailable storage, never the R2 copy =====
{
 const f=fresh('closed'),env={DB:d1Standin(f),BUCKET:bucket};
 r2.set(KEY,{itemsHash:'r2-copy'});
 assert.equal((await api.lbaObject(env,KEY)).value,undefined,'closed: the read is unavailable');
 await assert.rejects(()=>api.lbaCommitCandidates(env,origin,4,plan('h1',['x1'])),/storage_unavailable/);
 const g=fresh('d1');sqlite(g,'DROP TABLE letterboxd_admission_authority');
 assert.equal((await api.lbaObject({DB:d1Standin(g),BUCKET:bucket},KEY)).value,undefined,'an unreadable marker is unavailable');
}

// ===== r2: the delivered path is unchanged (an etagDoesNotMatch put into R2) =====
{
 const f=fresh('r2'),env={DB:d1Standin(f),BUCKET:bucket};
 r2.clear();puts.length=0;registered.length=0;
 const out=await api.lbaCommitCandidates(env,origin,4,plan('h1',['y1']));
 assert.equal(out.replay,false);assert.deepEqual(puts,[KEY]);assert.equal(r2.get(KEY).itemsHash,'h1');
 assert.equal(rows(f,"SELECT COUNT(*) AS n FROM ratings_document WHERE key LIKE 'letterboxd/imports/%'")[0].n,0,'nothing in D1 at r2');
 assert.equal((await api.lbaCommitCandidates(env,origin,4,plan('h1',['y1']))).replay,true);
}

console.log('Letterboxd archive apply at d1 (AIR-602, ADR 0222): D1 result document, replay, conflict, closed and unreadable markers, unchanged r2 passed.');
