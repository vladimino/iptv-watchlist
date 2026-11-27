// AIR-532 production regression: the Worker bundle (`dist/server/index.js`, built by build.mjs) must give CanonicalRatedAdmission every binding it uses.
// PR 771 added `readRetentionWatermark` and `advanceRetentionWatermark` to the producer's ES imports. The bundle strips ES imports and injects a hand-written preamble, which did not
// name them, so in production both were undefined and the 19 Nov 2026 EPG stopped at `finalize` with `readRetentionWatermark is not defined`. The ES-module tests did not see it:
// there the real import resolves. This test runs the GENERATED bundle, not the sources.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

// The bundle is built here every time (build.mjs replaces its outputs atomically, so a concurrent build never exposes a missing file): a stale local dist must not stand in for the current sources.
execFileSync(process.execPath,['build.mjs'],{stdio:'ignore'});
const bundle=fs.readFileSync('dist/server/index.js','utf8');

// ---- 1. the build refuses a scoped module whose imports the preamble does not provide ----
{
 const {scopedImports}=await import(pathToFileURL(path.resolve('scripts/bundle-scope.mjs')).href);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-scope-'));
 try{
  const file=path.join(dir,'m.js');
  fs.writeFileSync(file,"import {alpha,beta} from './x.js';\nimport {unused} from './y.js';\nexport function run(){return alpha()+beta();}\n");
  assert.throws(()=>scopedImports(file,'M','const {alpha}=X;'),/imports and uses beta but the scope preamble does not provide it/,'a used import missing from the preamble fails the build');
  assert.ok(scopedImports(file,'M','const {alpha,beta}=X;').includes('return {run}'),'a complete preamble builds (an import the module never uses needs no binding)');
  fs.writeFileSync(file,"import {readAuthority as read} from './x.js';\nexport const go=()=>read();\n");
  assert.throws(()=>scopedImports(file,'M','const {readAuthority}=X;'),/imports and uses read but/,'an aliased import is checked under its local name');
  assert.ok(scopedImports(file,'M','const {readAuthority:read}=X;').includes('const M='),'and satisfied by the alias in the preamble');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}

// ---- 2. the generated scope chain runs the producer against a schema-25 D1 stand-in ----
const start=bundle.indexOf('const OrchestrationPolicy=(()=>{');
const begin=bundle.indexOf('const CanonicalRatedAdmission=(()=>{');
assert.ok(start>0&&begin>start,'the bundle holds the scoped chain up to CanonicalRatedAdmission');
const end=bundle.indexOf('\n})();',begin)+'\n})();'.length;
const sandbox={Date,Map,Set,JSON,Object,Number,Promise,console,crypto:globalThis.crypto,TextEncoder,TextDecoder,URL,structuredClone,setTimeout,clearTimeout};
const world=vm.createContext(sandbox);
vm.runInContext(bundle.slice(start,end)+'\nglobalThis.CR=CanonicalRatedAdmission;\nglobalThis.FA=CanonicalFilmAdmission;\n',world);
const {CR,FA}=world;
assert.equal(typeof CR.applyRatedAdmissionRetention,'function','the producer is in the generated scope');
assert.equal(typeof FA.readRetentionWatermark,'function','the watermark reader is exported by the generated film-admission scope');
assert.equal(typeof FA.advanceRetentionWatermark,'function','the watermark writer is exported by the generated film-admission scope');

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-bundle-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8'});const o=r.stdout.trim();return o?JSON.parse(o):[];};
const file=path.join(root,'b.sqlite');
sqlite(file,fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
sqlite(file,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:00.000Z');INSERT INTO film (id,contract_version,updated_at) VALUES ('film:tmdb:91',1,'2026-11-01T00:00:00.000Z');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:tmdb:91','tmdb','91',1,0,NULL),('film:tmdb:91','letterboxd','b91',1,0,NULL);");
assert.equal(Number(rows(file,'SELECT version FROM schema_contract WHERE id=1')[0].version),50,'the stand-in is a schema-50 database');
const env=()=>({DB:d1Standin(file)});
const d=n=>'2026-11-'+n+'T12:00:00.000Z';
const scan=(event,at)=>CR.applyRatedAdmissionRetention(env(),{event,retentions:[{lid:'b91',tmdbId:'91',watchlist:true,observedAt:at,evidence:{scanId:event}}],now:()=>at});
const state=()=>rows(file,"SELECT r.observed_at AS at,r.request_id AS rid,c.revision AS rev FROM film_retention r JOIN canonical_revision c ON c.kind='film' AND c.id=r.film_id WHERE r.film_id='film:tmdb:91'")[0];
const wm=()=>rows(file,'SELECT observed_at FROM film_retention_scan WHERE id=1')[0]?.observed_at??null;
const receipts=()=>Number(rows(file,'SELECT COUNT(*) AS n FROM canonical_write_receipt')[0].n);

const empty=await FA.readRetentionWatermark(env());
assert.equal(empty.present,true,'the generated reader sees the schema-25 watermark table');assert.equal(empty.observedAt,null,'and it is empty');
const first=await scan('g:1',d('10'));
assert.equal(first.state,'complete');assert.equal(first.applied,1,'first observation writes the Film');
assert.equal(wm(),d('10'),'the generated producer advanced the watermark (advanceRetentionWatermark ran)');
const before=state(),receiptsBefore=receipts();
const second=await scan('g:2',d('18'));
assert.equal(second.state,'complete');assert.equal(second.applied,0);assert.equal(second.noop,1,'an unchanged scan is a no-op (readRetentionWatermark ran and the plan used it)');
assert.deepEqual(state(),before,'no row, request id or revision rewrite');
assert.equal(receipts(),receiptsBefore,'no receipt');
assert.equal(wm(),d('18'),'the watermark moved to the newer scan');
console.log('canonical-rated-admission-bundle: the generated Worker scope provides the watermark bindings; the build refuses a scoped import the preamble lacks; an unchanged scan is a no-op on schema 25 passed');
