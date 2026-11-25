// AIR-602 (card A1) / ADR 0207 decision 1 (Accepted): migration 0044 and the Letterboxd admission authority marker, on the sqlite3-CLI D1 stand-in. No Worker, R2, network or production.
// Covered: the migration's refusal, replay and what it writes; the chain r2 -> closed -> d1 and closed -> r2 enforced by triggers (every illegal transition, generation rules, the kept row);
// the fresh positive-proof read (absent below 44, r2, closed, d1) and every case that must never read as r2 (unreadable D1, missing row at 44, missing table at 44, invalid mode); the gate before
// an R2 write; the batch conditions (legacy at r2 and at "migration absent", d1) including a batch planned before a close or before the migration was applied.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {ADMISSION_AUTHORITY_SCHEMA,admissionRoute,admissionRouteNow,d1BatchCondition,guardLegacyWrite,legacyBatchCondition,readAdmissionAuthority} from '../src/letterboxd-admission-authority.js';

const NEW='0044_letterboxd_admission_authority.sql',PREVIOUS='0043_film_redirect_by_target.sql';
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
assert.ok(files.includes(NEW),'0044 exists');
assert.equal(files[files.indexOf(NEW)-1],PREVIOUS,'0044 follows 0043');
assert.equal(ADMISSION_AUTHORITY_SCHEMA,44);
const chain=files.slice(0,files.indexOf(NEW));
const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-admission-authority-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const read=name=>fs.readFileSync('migrations/'+name,'utf8');
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const ok=(file,text)=>{const r=sqlite(file,text);assert.equal(r.status,0,r.stderr+' <- '+text);};
const refused=(file,text,pattern)=>{const r=sqlite(file,text);assert.notEqual(r.status,0,'expected a refusal: '+text);if(pattern)assert.match(r.stderr,pattern,text);};
const code=expected=>error=>{assert.equal(error.code,expected,String(error?.stack||error));return true;};

const template43=path.join(root,'t43.sqlite'),template=path.join(root,'t44.sqlite');
ok(template43,chain.map(read).join('\n'));
fs.copyFileSync(template43,template);
ok(template,read(NEW));
let n=0;
const copy=source=>{const file=path.join(root,'w-'+(n++)+'.sqlite');fs.copyFileSync(source,file);return file;};
const envOf=file=>({DB:d1Standin(file)});
const STAMP='2026-11-25T10:00:00.000Z';
const marker=file=>rows(file,'SELECT mode,generation,activated_at AS at FROM letterboxd_admission_authority WHERE id=1')[0];

// ===== 1. the migration =====
{
 const objects=file=>one(file,"SELECT COUNT(*) FROM sqlite_master WHERE type IN ('table','trigger','index')");
 const before=objects(template43);
 const stale=copy(template43);
 // a version 42 (one step short) is refused and creates nothing
 const t42=path.join(root,'t42.sqlite');ok(t42,chain.slice(0,-1).map(read).join('\n'));
 const before42=objects(t42);
 refused(t42,read(NEW));
 assert.equal(objects(t42),before42,'a refused file creates nothing');
 assert.equal(one(t42,'SELECT version FROM schema_contract WHERE id=1'),42);
 // a version 43 whose receipt table lost the 0039 column, or whose redirect index is missing, is not a complete 43
 const noIndex=copy(template43);ok(noIndex,'DROP INDEX film_redirect_by_target');
 refused(noIndex,read(NEW));assert.equal(objects(noIndex),before-1);
 const noTrigger=copy(template43);ok(noTrigger,'DROP TRIGGER schema_contract_no_downgrade');
 refused(noTrigger,read(NEW));
 // an object of the new name already present
 const taken=copy(template43);ok(taken,'CREATE TABLE letterboxd_admission_authority_x (a INTEGER)');
 refused(taken,read(NEW));
 // the accepted file: the marker is r2, generation 0, and nothing else of the data changes
 ok(stale,read(NEW));
 assert.deepEqual({...marker(stale)},{mode:'r2',generation:0,at:null},'the inserted marker is r2, generation 0');
 assert.equal(one(stale,'SELECT version FROM schema_contract WHERE id=1'),44);
 assert.equal(one(stale,"SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'letterboxd_admission_authority%'"),4,'one table and three triggers');
 assert.equal(one(stale,'SELECT COUNT(*) FROM film_rated_admission'),0);
 // a second apply is refused (the version is 44 now) and changes nothing
 const after=objects(stale);
 refused(stale,read(NEW));
 assert.equal(objects(stale),after);
 assert.equal(one(stale,'SELECT COUNT(*) FROM letterboxd_admission_authority'),1);
 // the version never goes down
 refused(stale,'UPDATE schema_contract SET version=43 WHERE id=1',/schema_contract_downgrade/);
}

// ===== 2. the chain: r2 -> closed -> d1, closed -> r2 before an activation, nothing out of d1; every change of mode raises the generation =====
{
 const file=copy(template);
 refused(file,"UPDATE letterboxd_admission_authority SET mode='d1',generation=1,activated_at='"+STAMP+"'",/letterboxd_admission_authority_chain/);
 refused(file,"UPDATE letterboxd_admission_authority SET mode='closed'",/letterboxd_admission_authority_chain/);
 refused(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=0",/letterboxd_admission_authority_chain/);
 refused(file,"UPDATE letterboxd_admission_authority SET generation=5",/letterboxd_admission_authority_chain/);
 refused(file,"UPDATE letterboxd_admission_authority SET mode='nope',generation=1",/CHECK constraint|letterboxd_admission_authority_chain/);
 ok(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1");
 assert.deepEqual({...marker(file)},{mode:'closed',generation:1,at:null});
 ok(file,"UPDATE letterboxd_admission_authority SET mode='r2',generation=2");
 assert.deepEqual({...marker(file)},{mode:'r2',generation:2,at:null},'closed -> r2 (the reopen) raises the generation');
 ok(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=3");
 refused(file,"UPDATE letterboxd_admission_authority SET mode='d1',generation=3,activated_at='"+STAMP+"'",/letterboxd_admission_authority_chain/);
 refused(file,"UPDATE letterboxd_admission_authority SET mode='d1',generation=4",/CHECK constraint/);
 refused(file,"UPDATE letterboxd_admission_authority SET mode='r2',generation=4,activated_at='"+STAMP+"'",/CHECK constraint/);
 refused(file,"UPDATE letterboxd_admission_authority SET mode='d1',generation=4,activated_at='not-a-time'",/CHECK constraint/);
 ok(file,"UPDATE letterboxd_admission_authority SET mode='d1',generation=4,activated_at='"+STAMP+"'");
 assert.deepEqual({...marker(file)},{mode:'d1',generation:4,at:STAMP});
 for(const to of ['closed','r2'])refused(file,"UPDATE letterboxd_admission_authority SET mode='"+to+"',generation=5,activated_at=NULL",/letterboxd_admission_authority_(one_way|chain)/);
 refused(file,'UPDATE letterboxd_admission_authority SET generation=3',/letterboxd_admission_authority_(one_way|chain)/);
 refused(file,"UPDATE letterboxd_admission_authority SET activated_at=NULL",/CHECK constraint/);
 refused(file,'DELETE FROM letterboxd_admission_authority',/letterboxd_admission_authority_keep/);
 refused(file,"INSERT INTO letterboxd_admission_authority (id,mode,generation) VALUES (2,'r2',0)",/CHECK constraint/);
 assert.deepEqual({...marker(file)},{mode:'d1',generation:4,at:STAMP},'every refusal left the marker untouched');
}

// ===== 3. the fresh read: positive proof of legacy routing; nothing unreadable is r2 =====
{
 // below 44 and no table: legacy, not installed (the deployment of this card runs before the migration exists)
 const old=path.join(root,'t43-read.sqlite');fs.copyFileSync(template43,old);
 assert.deepEqual({...await readAdmissionAuthority(envOf(old))},{mode:'r2',proof:'not_installed',generation:0,installed:false,version:43});
 assert.equal(admissionRoute(await readAdmissionAuthority(envOf(old))),'legacy');
 // no binding at all is not a database: legacy not_installed
 assert.equal((await readAdmissionAuthority({})).proof,'not_installed');
 // installed r2 / closed / d1
 const file=copy(template);
 assert.deepEqual({...await readAdmissionAuthority(envOf(file))},{mode:'r2',proof:'explicit_r2',generation:0,installed:true,version:44});
 ok(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1");
 assert.deepEqual({...await readAdmissionAuthority(envOf(file))},{mode:'closed',proof:'closed',generation:1,installed:true,version:44});
 assert.equal(admissionRoute(await readAdmissionAuthority(envOf(file))),'closed');
 ok(file,"UPDATE letterboxd_admission_authority SET mode='d1',generation=2,activated_at='"+STAMP+"'");
 assert.deepEqual({...await readAdmissionAuthority(envOf(file))},{mode:'d1',proof:'d1',generation:2,installed:true,version:44});
 assert.equal(admissionRoute(await readAdmissionAuthority(envOf(file))),'d1');
 // never r2: an unreadable D1, a missing table at 44, a missing row, an invalid mode (the CHECK is dropped to make one), a table beside a version below 44
 await assert.rejects(()=>readAdmissionAuthority({DB:{prepare(){throw new Error('down');}}}),code('letterboxd_admission_unavailable'));
 const noTable=copy(template);ok(noTable,'DROP TRIGGER letterboxd_admission_authority_keep;DROP TRIGGER letterboxd_admission_authority_one_way;DROP TRIGGER letterboxd_admission_authority_chain;DROP TABLE letterboxd_admission_authority');
 await assert.rejects(()=>readAdmissionAuthority(envOf(noTable)),error=>error.code==='letterboxd_admission_unavailable'&&error.reason==='table_missing');
 const noRow=copy(template);ok(noRow,'DROP TRIGGER letterboxd_admission_authority_keep;DELETE FROM letterboxd_admission_authority');
 await assert.rejects(()=>readAdmissionAuthority(envOf(noRow)),error=>error.code==='letterboxd_admission_unavailable'&&error.reason==='row_missing');
 const badMode=copy(template);ok(badMode,"DROP TRIGGER letterboxd_admission_authority_chain;DROP TRIGGER letterboxd_admission_authority_one_way;PRAGMA ignore_check_constraints=ON;UPDATE letterboxd_admission_authority SET mode='nope'");
 await assert.rejects(()=>readAdmissionAuthority(envOf(badMode)),error=>error.code==='letterboxd_admission_unavailable'&&error.reason==='invalid_row');
 const outOfChain=copy(template43);ok(outOfChain,read(NEW).replace(/UPDATE schema_contract[\s\S]*$/,''));
 await assert.rejects(()=>readAdmissionAuthority(envOf(outOfChain)),error=>error.code==='letterboxd_admission_unavailable'&&error.reason==='version_mismatch');
 // an unreadable version beside an absent table is no proof either
 const noContract=copy(template43);ok(noContract,'DROP TRIGGER schema_contract_no_downgrade;DROP TABLE schema_contract');
 await assert.rejects(()=>readAdmissionAuthority(envOf(noContract)),code('letterboxd_admission_unavailable'));
 // the pure router refuses anything it cannot vouch for
 assert.throws(()=>admissionRoute(null),code('letterboxd_admission_unavailable'));
 assert.throws(()=>admissionRoute({mode:'r2',proof:'closed'}),code('letterboxd_admission_unavailable'));
 assert.throws(()=>admissionRoute({mode:'d1',proof:'explicit_r2'}),code('letterboxd_admission_unavailable'));
}

// ===== 4. the gate before an R2 write: reads FRESH and refuses unless the marker proves r2 or proves the migration absent =====
{
 const file=copy(template);
 const env=envOf(file);
 assert.equal((await guardLegacyWrite(env)).proof,'explicit_r2');
 ok(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1");
 await assert.rejects(()=>guardLegacyWrite(env),error=>error.code==='letterboxd_admission_closed'&&error.mode==='closed','a request that read r2 earlier still refuses at its own write');
 ok(file,"UPDATE letterboxd_admission_authority SET mode='r2',generation=2");
 assert.equal((await guardLegacyWrite(env)).generation,2,'reopen lets the legacy writer through again');
 ok(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=3;UPDATE letterboxd_admission_authority SET mode='d1',generation=4,activated_at='"+STAMP+"'");
 await assert.rejects(()=>guardLegacyWrite(env),error=>error.code==='letterboxd_admission_closed'&&error.mode==='d1','after d1 the Worker never writes the object again');
 const old=path.join(root,'t43-guard.sqlite');fs.copyFileSync(template43,old);
 assert.equal((await guardLegacyWrite(envOf(old))).proof,'not_installed');
 await assert.rejects(()=>guardLegacyWrite({DB:{prepare(){throw new Error('down');}}}),code('letterboxd_admission_unavailable'));
 const {route}=await admissionRouteNow(envOf(copy(template)));assert.equal(route,'legacy');
}

// ===== 5. the batch conditions: a legacy batch cannot land under closed or d1, a new-path batch only under d1 at its generation =====
{
 // a one-statement batch asserting the condition, as the writers do: false -> the statement raises, the batch rolls back
 const assertion=condition=>{const sql='SELECT CASE WHEN ('+condition.sql+') THEN 1 ELSE json(\'x\') END AS ok';return {sql,params:condition.params};};
 const run=async(file,condition)=>{const db=d1Standin(file);const item=assertion(condition);try{await db.batch([db.prepare(item.sql).bind(...item.params)]);return true;}catch{return false;}};
 const file=copy(template);
 const r2=await readAdmissionAuthority(envOf(file));
 assert.equal(await run(file,legacyBatchCondition(r2)),true,'r2 at the read generation: the legacy batch lands');
 ok(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1");
 assert.equal(await run(file,legacyBatchCondition(r2)),false,'a batch planned at r2 is refused after the close');
 ok(file,"UPDATE letterboxd_admission_authority SET mode='r2',generation=2");
 assert.equal(await run(file,legacyBatchCondition(r2)),false,'and after a close and reopen: the generation moved, the planner replans');
 assert.equal(await run(file,legacyBatchCondition(await readAdmissionAuthority(envOf(file)))),true,'a fresh read lands again');
 assert.throws(()=>d1BatchCondition(r2),error=>error.code==='letterboxd_admission_closed'&&error.mode==='r2','only a d1 authority has a new-path condition');
 // "migration absent": the condition is a commit-time check that the table is STILL absent
 const old=path.join(root,'t43-batch.sqlite');fs.copyFileSync(template43,old);
 const absent=await readAdmissionAuthority(envOf(old));
 assert.equal(await run(old,legacyBatchCondition(absent)),true,'absent: the legacy batch lands (the statement never names the missing table)');
 ok(old,read(NEW));
 assert.equal(await run(old,legacyBatchCondition(absent)),false,'a batch prepared before the migration was applied cannot commit after it');
 // d1
 const d1file=copy(template);
 ok(d1file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1");
 const closed=await readAdmissionAuthority(envOf(d1file));
 assert.throws(()=>legacyBatchCondition(closed),error=>error.code==='letterboxd_admission_closed'&&error.mode==='closed','closed has no legacy batch');
 assert.throws(()=>d1BatchCondition(closed),error=>error.code==='letterboxd_admission_closed');
 ok(d1file,"UPDATE letterboxd_admission_authority SET mode='d1',generation=2,activated_at='"+STAMP+"'");
 const d1=await readAdmissionAuthority(envOf(d1file));
 assert.equal(await run(d1file,d1BatchCondition(d1)),true,'d1 at the read generation: the new-path batch lands');
 assert.throws(()=>legacyBatchCondition(d1),error=>error.code==='letterboxd_admission_closed'&&error.mode==='d1','a legacy batch cannot land under d1');
 assert.equal(await run(d1file,d1BatchCondition({...d1,generation:1})),false,'a new-path batch at another generation is refused');
 assert.equal(await run(copy(template),d1BatchCondition({...d1})),false,'a new-path batch is refused while the marker is not d1');
}

console.log('Letterboxd admission authority (AIR-602, migration 0044) passed.');
