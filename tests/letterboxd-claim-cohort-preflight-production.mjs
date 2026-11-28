// AIR-653: the READ-ONLY production wrapper of the bounded cohort preflight (scripts/letterboxd-claim-cohort-preflight-production.mjs). Offline only: the D1 REST transport is a stub over a
// scratch sqlite database built from the real migration chain; no network, no credential value, no production access.
//  - arguments: required private output, bounded caps, the witness archives must be sha256; the private file must be outside the repository;
//  - the transport guard: only one SELECT / WITH...SELECT is sent, every other statement shape is refused BEFORE any request, a response that reports a write stops the run;
//  - a full run over the stub: every request on the wire is a read, the printed report is sanitized (counts, reasons, digests; no lid, movie, key or Film id), the private file is mode 600
//    and holds the exact result, the identity of the target is checked first and a wrong identity stops the run before any statement.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {migrated} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {PRODUCTION_ACCOUNT_ID,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME} from '../scripts/published-epg-production.mjs';
import {parseArgs,privatePath,readOnlyTransport,sanitize,run,CAP_CEILINGS} from '../scripts/letterboxd-claim-cohort-preflight-production.mjs';

const HEX='a'.repeat(64);
const argv=(...rest)=>['node','script',...rest];
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-cohort-prod-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});

// ---- 1. arguments ----------------------------------------------------------------------------------------------------------------------------------
assert.throws(()=>parseArgs(argv()),/--out/,'a private output is required');
assert.throws(()=>parseArgs(argv('--out')),/--out needs a path/);
assert.throws(()=>parseArgs(argv('--out','x','--archive','nothex')),/64-hex/);
assert.throws(()=>parseArgs(argv('--out','x','--statements','0')),/1 to/);
assert.throws(()=>parseArgs(argv('--out','x','--statements',String(CAP_CEILINGS.statements+1))),/1 to/,'a cap above its ceiling is refused');
assert.throws(()=>parseArgs(argv('--out','x','--rows','1.5')),/integer/);
assert.throws(()=>parseArgs(argv('--out','x','--unknown','1')),/unknown option/);
const parsed=parseArgs(argv('--out','/tmp/x.json','--archive',HEX,'--archive','b'.repeat(64),'--statements','400','--pointer-inspect','3000'));
assert.deepEqual([parsed.out,parsed.archives.length,parsed.caps],['/tmp/x.json',2,{statements:400,pointerInspect:3000}]);
assert.throws(()=>privatePath('docs/evidence/x.json'),/outside the repository/,'a relative path inside the repository is refused');
assert.throws(()=>privatePath(path.resolve('scripts/x.json')),/outside the repository/);
assert.equal(privatePath(path.join(root,'x.json')),path.join(root,'x.json'));

// ---- 2. the transport guard --------------------------------------------------------------------------------------------------------------------------
const answered=[];
const echo=async(url,init)=>{answered.push({url,init});return new Response(JSON.stringify({success:true,result:[{success:true,results:[],meta:{rows_read:3,rows_written:0,changed_db:false}}]}),{status:200});};
const stats={requests:0,rowsRead:0,rowsWritten:0};
const guarded=readOnlyTransport(echo,stats);
const post=sql=>guarded('https://example.invalid/accounts/a/d1/database/d/query',{method:'POST',body:JSON.stringify({sql})});
for(const good of ['SELECT 1;','  select film_id FROM film WHERE id IN (SELECT value FROM json_each(\'["x"]\')) LIMIT 5;',"WITH g AS (SELECT 1 AS a) SELECT a FROM g;","SELECT 'update me; insert into x' AS t;"])await post(good);
assert.equal(answered.length,4,'four reads went out');
assert.equal(stats.rowsRead,12);assert.equal(stats.rowsWritten,0);
const before=answered.length;
for(const bad of ['INSERT INTO film (id) VALUES (1);','UPDATE film SET id=1;','DELETE FROM film;','DROP TABLE film;','PRAGMA writable_schema=1;','SELECT 1; DELETE FROM film;','CREATE INDEX i ON film (id);','REPLACE INTO film (id) VALUES (1);','','BEGIN;'])await assert.rejects(()=>post(bad),/write_or_unknown_statement_refused/,bad);
await assert.rejects(()=>guarded('https://example.invalid/x',{method:'POST',body:JSON.stringify({batch:[{sql:'SELECT 1'}]})}),/write_or_unknown_statement_refused/,'a batch body is refused');
await assert.rejects(()=>guarded('https://example.invalid/x',{method:'DELETE'}),/write_or_unknown_statement_refused/);
await assert.rejects(()=>guarded('https://example.invalid/x',{method:'POST',body:'not json'}),/write_or_unknown_statement_refused/);
assert.equal(answered.length,before,'a refused statement never reaches the network');
const writer=readOnlyTransport(async()=>new Response(JSON.stringify({success:true,result:[{success:true,results:[],meta:{rows_written:2,changed_db:true}}]}),{status:200}),{requests:0,rowsRead:0,rowsWritten:0});
await assert.rejects(()=>writer('https://example.invalid/x',{method:'POST',body:JSON.stringify({sql:'SELECT 1'})}),/unexpected_write_reported/,'an answer that reports a write stops the run');

// ---- 3. a full run over a stub transport: the empty cohort of a clean database -------------------------------------------------------------------------
// The same seeding as the AIR-652 fixture: Film/Person open at generation 2, the receipt baseline, the ratings domain d1/open.
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:01.000Z');";
const file=path.join(root,'world.sqlite');
fs.copyFileSync(migrated(),file);
const exec=text=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<28});assert.equal(r.status,0,r.stderr);};
exec(VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;"+BASELINE+"UPDATE ratings_domain_authority SET mode='d1',cutover='open' WHERE id=1;");
const dumpOf=()=>String(sqliteSync([file,'.dump'],{encoding:'utf8',maxBuffer:1<<30}).stdout);
const worldBefore=dumpOf();

const wire=[];
const stub=identity=>async(url,init={})=>{
 wire.push({url:String(url),method:init.method||'GET',body:init.body?JSON.parse(init.body):null});
 if((init.method||'GET')==='GET')return new Response(JSON.stringify({success:true,result:identity}),{status:200});
 const sql=JSON.parse(init.body).sql;
 const r=sqliteSync(['-json','-bail',file],{input:sql,encoding:'utf8',maxBuffer:1<<28});
 if(r.status!==0)return new Response(JSON.stringify({success:false,errors:[{message:String(r.stderr).slice(0,100)}]}),{status:400});
 const out=String(r.stdout).trim();
 return new Response(JSON.stringify({success:true,result:[{success:true,results:out?JSON.parse(out):[],meta:{rows_read:1,rows_written:0,changed_db:false}}]}),{status:200});
};
const env={D1_BACKFILL_ACCOUNT_ID:PRODUCTION_ACCOUNT_ID,D1_BACKFILL_API_TOKEN:'dummy-not-a-credential'};
const out=path.join(root,'private','allowlist.json');
fs.mkdirSync(path.dirname(out));
const logged=[];
const report=await run({argv:argv('--out',out,'--archive',HEX),env,fetchImpl:stub({uuid:PRODUCTION_DATABASE_ID,name:PRODUCTION_DATABASE_NAME}),log:text=>logged.push(text)});
assert.equal(report.decision,'complete','a clean database certifies an empty cohort');
assert.deepEqual(report.counts,{});
assert.deepEqual(report.byClassAndReason,{});
assert.ok(wire.length>0,'requests went out');
const posts=wire.filter(item=>item.method==='POST');
assert.ok(posts.length>0&&posts.every(item=>typeof item.body.sql==='string'&&item.body.batch===undefined&&/^\s*(select|with)\b/i.test(item.body.sql)),'every request on the wire is a single read');
assert.equal(wire[0].method,'GET','the target identity is read first');
assert.equal(report.transport.rowsWritten,0);assert.equal(report.transport.requests,wire.length);
assert.equal(dumpOf(),worldBefore,'the database is byte-for-byte unchanged by the run');
assert.equal(logged.length,1);
{const shown=JSON.parse(logged[0]);assert.ok(['results','snapshot','eligible','subjects'].every(key=>!(key in shown)),'the printed report has no result list');assert.ok(Object.values(shown.byClassAndReason).every(count=>Number.isInteger(count)),'only counts per class and reason');}
const privateFile=JSON.parse(fs.readFileSync(out,'utf8'));
assert.deepEqual([privateFile.eligible,privateFile.results],[[],[]]);
assert.equal(fs.statSync(out).mode&0o777,0o600,'the private file is mode 600');
assert.equal(report.witnessScope.archives,1);
assert.deepEqual(report.liveBlockers.filter(item=>item.startsWith('ratings_view_fact_key_index_0055')).length,1,'the 0055 prerequisite stays listed until its readback is recorded in the evidence');

// A wrong database identity stops the run before any statement.
wire.length=0;
await assert.rejects(()=>run({argv:argv('--out',path.join(root,'private','x.json')),env,fetchImpl:stub({uuid:'00000000-0000-0000-0000-000000000000',name:'other'}),log:()=>{}}),/target_identity_mismatch/);
assert.deepEqual(wire.map(item=>item.method),['GET'],'only the identity read went out');
// A private path inside the repository is refused before any request.
wire.length=0;
await assert.rejects(()=>run({argv:argv('--out','docs/leak.json'),env,fetchImpl:stub({uuid:PRODUCTION_DATABASE_ID,name:PRODUCTION_DATABASE_NAME}),log:()=>{}}),/outside the repository/);
assert.equal(wire.length,0);
// The sanitizer never carries the result list.
const sanitized=sanitize({decision:'complete',results:[{lid:'AAA1',movie:'1',state:'unknown',reason:'x'}],work:{},liveBlockers:[]},{archives:[]});
assert.ok(!JSON.stringify(sanitized).includes('AAA1'),'the sanitized report has no lid');
assert.deepEqual(sanitized.byClassAndReason,{'unknown / x':1});

console.log('letterboxd claim cohort preflight production wrapper: ok');
