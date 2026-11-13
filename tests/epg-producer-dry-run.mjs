// AIR-374 M2 (ADR 0128 staged plan): the offline, read-only dry-run harness of the EPG producer plan (scripts/epg-producer-dry-run.mjs) on the sqlite3-CLI D1 stand-in. Covered: the counts (changed, no-op, absent, refused by code) agree
// with what the real apply path does on a COPY of the same database, nothing is ever written (the database file is byte-identical, every write statement class is refused by the guard), the output holds counts and timings only, the
// timing and fingerprint figures come from the injected clock, and the harness imports no apply function or writer. No Worker, R2, D1 or Cloudflare access.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {pathToFileURL} from 'node:url';
// DRYRUN_SCRIPT points the file at a mutant copy of the harness (its src/ and sibling scripts beside it).
const {DryRunWriteRefused,dryRun,readOnlyBinding}=await import(pathToFileURL(path.resolve(process.env.DRYRUN_SCRIPT||'scripts/epg-producer-dry-run.mjs')).href);
import {applyEpgUnits,planEpgUnits} from '../src/canonical-epg-producer.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-dry-run-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const template=path.join(root,'template.sqlite');
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
assert.equal(sqlite(template,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:00.000Z');";
let n=0;
function openDatabase(){
 const file=path.join(root,'d-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 for(const statement of [VERIFY,"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1","UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1",BASELINE])assert.equal(sqlite(file,statement).status,0);
 return file;
}
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const T='2026-11-13T10:00:00.000Z';
const ID=k=>'film:tmdb:'+k;
const META=()=>({schemaVersion:1,year:1999,runtime:136,synopsis:'S',poster:'/p.jpg',url:'https://example.test/m',genres:['g'],peopleVersion:2,payload:{k:'v'},r2Key:null,contentSha256:null,updatedAt:T});
const facts=title=>({film:{contractVersion:1,originalTitle:title,source:'tmdb'},metadata:META(),sync:{metadataAt:T,synopsisFetchedAt:T,peopleNamesVersion:2,peopleLocalizedAt:T},watchlist:true});
const code=expected=>error=>error.code===expected;

// The stored state: Film 1 is already canonical (the real apply path wrote it), Film 2 is new, Film 9 is departed and absent, Film 3's facts are malformed.
async function seeded(){
 const file=openDatabase();
 const first=await applyEpgUnits({DB:d1Standin(file)},{plan:planEpgUnits({runId:'seed',at:T,films:[{id:ID(1),facts:facts('A')}]}),now:()=>T});
 assert.equal(first.counts.applied,1);
 return file;
}
const inputs={at:T,runId:'run-1',
 films:[{id:ID(1),facts:facts('A')},{id:ID(2),facts:facts('B')},{id:ID(3),facts:'malformed'}],
 departed:[ID(9)],
 personRows:[{id:'person:tmdb:1',roleId:'role:1',contractVersion:1},{id:'person:tmdb:2',roleId:'role:2',contractVersion:1}],
 credits:[{filmId:ID(1),credits:[{personId:'person:tmdb:7',role:'director'}]}],
};
const steady=()=>{let t=0;return ()=>(t+=2);};

// 1. The counts, and their agreement with the real apply path run on a COPY of the same database.
{
 const file=await seeded();
 const before=sha(file);
 const out=await dryRun({env:{DB:d1Standin(file)},...inputs,clock:steady()});
 assert.equal(sha(file),before,'the database file is byte-identical after the dry run');
 assert.equal(out.writes,0);
 assert.deepEqual(out.byKind.film_facts,{units:3,changed:1,noop:1,absent:1,refused:1,failed:0},'Film 1 no-op, Film 2 changed, Film 9 (a release with no stored Film) absent, Film 3 refused by the planner');
 assert.deepEqual(out.byKind.person_mutation,{units:2,changed:2,noop:0,absent:0,refused:0,failed:0});
 assert.deepEqual(out.byKind.film_credits,{units:1,changed:0,noop:0,absent:0,refused:1,failed:0},'a credit whose Person is not stored is refused film_person_reference');
 assert.deepEqual(out.refusedByCode,{film_person_invalid:1,film_person_reference:1});
 assert.deepEqual(out.failedByCode,{});
 assert.equal(out.planned.units,6);assert.equal(out.planned.refusedByPlanner,1);
 assert.equal(out.changed,3);assert.equal(out.changedShare,0.5);
 // fidelity: the real film apply on a copy does what the dry run said
 const copy=path.join(root,'copy.sqlite');fs.copyFileSync(file,copy);
 const real=await applyEpgUnits({DB:d1Standin(copy)},{plan:planEpgUnits({runId:'run-1',at:T,films:inputs.films.filter(item=>typeof item.facts==='object'),departed:inputs.departed}),now:()=>T});
 assert.deepEqual([real.counts.noop,real.counts.applied,real.counts.absent],[out.byKind.film_facts.noop,out.byKind.film_facts.changed,out.byKind.film_facts.absent],'the dry run agrees with the apply path');
}

// 2. Timings come from the injected clock: per-unit latency, D1 reads per unit, the plan and the fingerprint.
{
 const file=await seeded();
 const out=await dryRun({env:{DB:d1Standin(file)},...inputs,clock:steady()});
 assert.equal(out.latencyMs.n,6);
 assert.ok(out.latencyMs.p50>0&&out.latencyMs.max>=out.latencyMs.p50&&out.d1ReadsPerUnit.max>=out.d1ReadsPerUnit.p50&&out.d1ReadsPerUnit.total>0);
 assert.ok(out.planMs>0&&out.fingerprint.ms>0,'the plan and the fingerprint are timed');
 // 4 digested units (Film 1, Film 2, two Persons) + 1 planner refusal (Film 3) = 5 entries; the release with no stored Film and the refused credit have no digest: reported, never dropped silently
 assert.equal(out.fingerprint.entries,5,'the digested units AND the planner refusal are plan entries');
 assert.deepEqual([out.fingerprint.complete,out.fingerprint.missing.unresolved_release,out.fingerprint.missing.unit_refused,out.fingerprint.missing.total,out.fingerprint.error],[false,1,1,2,null]);
 const again=await dryRun({env:{DB:d1Standin(file)},...inputs,clock:steady()});
 assert.deepEqual(again,out,'the same input and the same clock give the same report');
}

// 2b. The fingerprint measurement covers exactly the producer's ordered plan entries, planner refusals included, and an incomplete measurement is never reported as a full one.
{
 const file=await seeded();
 const clean={...inputs,films:[{id:ID(1),facts:facts('A')},{id:ID(2),facts:facts('B')}],departed:[],credits:[]};
 const base=await dryRun({env:{DB:d1Standin(file)},...clean,clock:steady()});
 assert.deepEqual([base.fingerprint.complete,base.fingerprint.entries,base.fingerprint.missing.total],[true,4,0],'a plan with every digest is a complete measurement');
 const withRefusal=await dryRun({env:{DB:d1Standin(file)},...clean,films:[...clean.films,{id:ID(3),facts:'malformed'}],clock:steady()});
 assert.equal(withRefusal.planned.refusedByPlanner,1);
 assert.deepEqual([withRefusal.fingerprint.complete,withRefusal.fingerprint.entries],[true,base.fingerprint.entries+1],'a planner refusal is one more plan entry in the count and the fingerprint');
 // every unit fails while planned (a read error, not a write): nothing is digested, the measurement is incomplete and says why
 const broken={DB:{prepare:()=>{throw new Error('read failed');}}};
 const failed=await dryRun({env:broken,...clean,clock:steady()});
 assert.equal(failed.fingerprint.complete,false);
 assert.ok(failed.fingerprint.missing.unit_failed>0&&failed.fingerprint.missing.total===failed.fingerprint.missing.unit_failed+failed.fingerprint.missing.unit_refused+failed.fingerprint.missing.unresolved_release);
 assert.ok(failed.fingerprint.entries<base.fingerprint.entries,'a smaller fingerprint is flagged incomplete, not a valid smaller measurement');
 // a failure while the fingerprint itself is being built is reported, never a complete figure: the clock throws on the call that starts the fingerprint timer (the last call but one)
 let calls=0;const counting=()=>{calls++;return calls*2;};
 await dryRun({env:{DB:d1Standin(file)},...clean,clock:counting});
 const total=calls;let seen=0;
 const faulty=()=>{seen++;if(seen===total-1)throw Object.assign(new Error('clock'),{code:'clock_broke'});return seen*2;};
 const broke=await dryRun({env:{DB:d1Standin(file)},...clean,clock:faulty});
 assert.deepEqual([broke.fingerprint.complete,broke.fingerprint.ms,broke.fingerprint.entries,broke.fingerprint.error],[false,null,0,'clock_broke']);
}

// 3. The report holds counts and timings only: no id, title, name or payload.
{
 const file=await seeded();
 const text=JSON.stringify(await dryRun({env:{DB:d1Standin(file)},...inputs,clock:steady()}));
 for(const needle of ['film:','person:','tmdb','role:','https://','Title','"A"','"B"','synopsis'])assert.ok(!text.includes(needle),'the report names '+needle);
}

// 4. The guard: every write statement class and every non-SELECT is refused, and a batch is never available.
{
 const file=await seeded();
 const binding=readOnlyBinding(d1Standin(file));
 for(const sql of ["INSERT INTO film (id,contract_version,updated_at) VALUES ('film:x',1,'t')","UPDATE film SET original_title='x'","DELETE FROM film","DROP TABLE film","CREATE TABLE t (a)","ALTER TABLE film ADD COLUMN z","REPLACE INTO film (id) VALUES ('x')","PRAGMA foreign_keys=OFF","ATTACH DATABASE 'x' AS y","VACUUM","SELECT 1; DELETE FROM film","WITH x AS (SELECT 1) DELETE FROM film","  insert into film values (1)"])
  assert.throws(()=>binding.prepare(sql),error=>error instanceof DryRunWriteRefused&&error.code==='dry_run_write_refused',sql);
 assert.throws(()=>binding.batch([]),code('dry_run_write_refused'));
 assert.throws(()=>binding.exec('SELECT 1'),code('dry_run_write_refused'));
 assert.throws(()=>readOnlyBinding(null),code('dry_run_write_refused'));
 assert.equal(binding.prepare('SELECT 1 AS x').bind().first!==undefined,true,'a SELECT is allowed');
 // the harness itself refuses a missing write clock
 await assert.rejects(dryRun({env:{DB:d1Standin(file)},films:[]}),code('dry_run_write_refused'));
 // a planner that tried to write would be stopped: the guard throws through the harness
 const sneaky={DB:{prepare:sql=>d1Standin(file).prepare(sql),batch:async()=>{throw new Error('never');}}};
 assert.equal((await dryRun({env:sneaky,...inputs,clock:steady()})).writes,0);
 // a refusal raised while a unit is being planned stops the whole dry run (it is never counted as a failed unit)
 const refusing={DB:{prepare:()=>({bind:()=>({first:async()=>{throw new DryRunWriteRefused('inside a planner');},all:async()=>{throw new DryRunWriteRefused('inside a planner');}})})}};
 await assert.rejects(dryRun({env:refusing,...inputs,clock:steady()}),code('dry_run_write_refused'));
}

// 5. Below `open` the harness still plans (it never reads the marker): the pre-plans are read-only, so a dry run on a `prepared` safe copy is the intended M2b use.
{
 const file=path.join(root,'prepared.sqlite');fs.copyFileSync(template,file);
 for(const statement of [VERIFY,"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1"])assert.equal(sqlite(file,statement).status,0);
 const before=sha(file);
 const out=await dryRun({env:{DB:d1Standin(file)},...inputs,clock:steady()});
 assert.equal(out.byKind.film_facts.changed,2,'nothing is stored: both observed Films would change');
 assert.equal(sha(file),before);
}

// 6. Static: the harness imports no apply function or writer, and no network, R2, timer or file write.
{
 const text=fs.readFileSync(process.env.DRYRUN_SCRIPT||'scripts/epg-producer-dry-run.mjs','utf8').replace(/\/\/.*$/gm,'');
 assert.ok(!/\b(applyFilmFacts|applyEpgUnits|applyEpgPersonUnits|applyPersonMutation|applyPersonState|applyFilmCredits|applyDictionaryUnits|receiptedWrite|writeFilmFacts|mutateFilm|mutatePerson|recordPersonState|reconcile\w*)\b/.test(text),'no apply function or writer');
 assert.ok(!/\b(fetch|setTimeout|setInterval|BUCKET|writeFile|appendFile|createWriteStream|execSync|spawn|child_process|process\.env)\b/.test(text),'no network, R2, timer, file write or process');
 assert.deepEqual([...text.matchAll(/from '([^']+)'/g)].map(match=>match[1]).sort(),['../src/canonical-epg-person-producer.js','../src/canonical-epg-producer.js','../src/canonical-person-adapters.js','../src/canonical-person-mutation-producer.js','../src/canonical-producer-adapters.js','../src/canonical-producer-adapters.js','../src/canonical-producer-run.js','./schema-preflight.mjs']);
 for(const file of ['build.mjs','package.json','wrangler.jsonc'])assert.ok(!fs.readFileSync(file,'utf8').includes('epg-producer-dry-run'),file+' does not carry the harness');
}
console.log('epg-producer-dry-run: ok');
