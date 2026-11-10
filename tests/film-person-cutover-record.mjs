// AIR-373: the two recording paths of `recordBaselineVerified` (src/film-person-baseline.js): the strict default, unchanged, and the explicit, versioned
// cutover_minimum path. The sqlite3-CLI D1 stand-in only: no R2, no network, no production access. Every refusal is checked by READING the baseline row.
// The ledgers here are hand-built GATE FIXTURES (the same builder inputs as tests/film-person-cutover-minimum.mjs): `verified:true` in them is test input for the
// recorder, not a measurement of anything. A run of the real tooling over synthetic data cannot produce one (tests/film-person-cutover-run.mjs).
// The mutation check (tests/film-person-cutover-record-mutation.mjs) points this file at a mutant through BASELINE_RECORD_MODULE.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {CLASSES,buildParityLedger,keyOf,ledgerDigest,sha256Hex} from '../src/film-person-baseline.js';
import {OWNER_LINK_WAIVER,REQUIRED_CLASSES,buildCutoverMinimumLedger,cutoverDigest,cutoverMinimumGate} from '../src/film-person-cutover-minimum.js';
const B=await import(process.env.BASELINE_RECORD_MODULE?pathToFileURL(path.resolve(process.env.BASELINE_RECORD_MODULE)).href:'../src/film-person-baseline.js');
const {RECORDING_PATHS,recordBaselineVerified,recordingReference}=B;

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-cutover-record-'));
process.on('exit',()=>fs.rmSync(root,{recursive:true,force:true}));
const sql=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';'});if(r.status!==0)throw new Error(r.stderr);const out=r.stdout.trim();return out?JSON.parse(out):[];};
// The migrated schema is built once and every test database is a file copy of it.
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const template=path.join(root,'template.sqlite');
sql(template,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
let n=0;
const database=()=>{const file=path.join(root,'b-'+(n++)+'.sqlite');fs.copyFileSync(template,file);return file;};
const env=file=>({DB:d1Standin(file)});
const AT='2026-11-10T12:00:00.000Z',LATER='2026-11-10T13:00:00.000Z';
const CM=RECORDING_PATHS.cutover_minimum;
const rowOf=file=>rows(file,'SELECT state, reference, updated_at FROM film_person_baseline')[0];
const markerOf=file=>rows(file,'SELECT mode, cutover, generation FROM film_person_authority')[0];
const EMPTY={state:'empty',reference:null,updated_at:null};
const code=value=>error=>error.code===value;
const gateFailed=reason=>error=>error.code==='baseline_gate_failed'&&error.reasons.some(item=>item===reason||item.startsWith(reason));

// ---- gate fixtures ----
const SRC=await sha256Hex('manifest'),ETAGS=await sha256Hex('etags'),FACTS=await sha256Hex('owner facts');
const identity=(generation=0,mode='r2')=>({schema:{version:18},marker:{mode,cutover:'open',generation},fence:{ok:1},baseline:{state:'empty',reference:null},published:{generation:7},owner:{mode:'d1',generation:1}});
const witness={film:'{"n":2}',person:'{"n":1}'};
const ownerKeys=[keyOf('film','alpha'),keyOf('person','beta')];
const classesFor=names=>Object.fromEntries(names.map(name=>[name,[[keyOf(name,'k1'),'["v"]'],[keyOf(name,'k2'),'["w"]']]]));
const inputs=(over={})=>({
 expected:{classes:classesFor(REQUIRED_CLASSES),unavailable:['ownerLink'],complete:true},
 actual:{classes:{...classesFor(REQUIRED_CLASSES),ownerLink:ownerKeys.map((k,i)=>[k,JSON.stringify(['link:'+i,'verified'])])},consistent:true,complete:true},
 source:{aggregateSha256:SRC,verified:true,kind:'projector-input-capture'},
 ownerLink:{authority:{mode:'d1',generation:1},factsBefore:{count:2,digest:FACTS},factsAfter:{count:2,digest:FACTS}},
 evidence:{manifestDigest:SRC,r2Etags:{before:ETAGS,after:ETAGS},d1:{before:identity(),after:identity()},witness:{before:witness,after:witness},fenceHeld:true,leaseLost:false,probeComplete:true},
 waivers:[{...OWNER_LINK_WAIVER}],
 ...over,
});
const cutover=async over=>(await buildCutoverMinimumLedger(inputs(over))).ledger;
const redigest=async ledger=>{ledger.cutoverDigest=await cutoverDigest(ledger);return ledger;};
// a ledger the STRICT gate passes: all 16 classes compared on both sides, a verified source
const all=CLASSES.map(item=>item.name);
const strict=async(source={aggregateSha256:SRC,verified:true})=>(await buildParityLedger({expected:{classes:classesFor(all),complete:true},actual:{classes:classesFor(all),consistent:true,complete:true},source})).ledger;
const record=(file,ledger,recordPath,over={})=>recordBaselineVerified(env(file),{ledger,expectedGeneration:0,at:AT,...(recordPath===undefined?{}:{path:recordPath}),...over});
// a refusal with the expected error that leaves the row exactly as it was
const refuses=async(file,ledger,recordPath,check,label,over={})=>{
 const before=rowOf(file);
 await assert.rejects(()=>record(file,ledger,recordPath,over),check,label);
 assert.deepEqual(rowOf(file),before,'nothing was recorded: '+label);
};

assert.deepEqual({...RECORDING_PATHS.strict},{gate:'strict',version:1});
assert.deepEqual({...CM},{gate:'cutover_minimum',version:1});
assert.ok(Object.isFrozen(RECORDING_PATHS)&&Object.isFrozen(CM)&&Object.isFrozen(RECORDING_PATHS.strict));
const good=await cutover();
assert.equal((await cutoverMinimumGate(good)).pass,true,'the fixture passes the cutover_minimum gate');
const REFERENCE='cutover_minimum/v1:'+good.cutoverDigest;
assert.equal(recordingReference(CM,good.cutoverDigest),REFERENCE);

// 1. the strict path is unchanged: it records the bare ledger digest, with or without its name, and it refuses a cutover_minimum ledger
{
 const pass=await strict();
 for(const recordPath of [undefined,RECORDING_PATHS.strict,{version:1,gate:'strict'}]){
  const file=database();
  assert.deepEqual(await record(file,pass,recordPath),{state:'verified',reference:pass.digest,already:false});
  assert.deepEqual(rowOf(file),{state:'verified',reference:pass.digest,updated_at:AT});
  assert.match(rowOf(file).reference,/^[0-9a-f]{64}$/,'the strict reference is the bare digest');
  assert.deepEqual(await record(file,pass,recordPath,{at:LATER}),{state:'verified',reference:pass.digest,already:true});
  assert.equal(rowOf(file).updated_at,AT,'a replay writes nothing');
  assert.deepEqual(markerOf(file),{mode:'r2',cutover:'open',generation:0});
 }
 const file=database();
 for(const recordPath of [undefined,RECORDING_PATHS.strict])await refuses(file,good,recordPath,gateFailed('class_unavailable:ownerLink'),'the strict path refuses a cutover_minimum ledger');
 assert.deepEqual(rowOf(file),EMPTY);
 await refuses(file,await strict({aggregateSha256:SRC,verified:false}),undefined,gateFailed('source_unverified'),'strict: unverified source');
}

// 2. the explicit path records, names its gate and version in the reference, never moves the marker, and a replay records once
{
 const file=database();
 assert.deepEqual(await record(file,good,CM),{state:'verified',reference:REFERENCE,already:false});
 assert.deepEqual(rowOf(file),{state:'verified',reference:REFERENCE,updated_at:AT});
 assert.deepEqual(markerOf(file),{mode:'r2',cutover:'open',generation:0},'recording never moves the marker');
 assert.notEqual(rowOf(file).reference,good.digest);assert.notEqual(rowOf(file).reference,good.cutoverDigest);
 assert.deepEqual(await record(file,good,{version:1,gate:'cutover_minimum'},{at:LATER}),{state:'verified',reference:REFERENCE,already:true});
 assert.deepEqual(rowOf(file),{state:'verified',reference:REFERENCE,updated_at:AT},'the replay wrote nothing');
 // a different ledger over a verified baseline is refused, on either path and in either direction
 const other=await cutover({ownerLink:{...inputs().ownerLink,expectedKeys:ownerKeys}});
 assert.equal((await cutoverMinimumGate(other)).pass,true);assert.notEqual(other.cutoverDigest,good.cutoverDigest);
 await refuses(file,other,CM,code('baseline_state_changed'),'another cutover ledger over a verified baseline');
 await refuses(file,await strict(),undefined,code('baseline_state_changed'),'a strict ledger over a cutover-verified baseline');
 const strictFile=database();const pass=await strict();
 await record(strictFile,pass);
 await refuses(strictFile,good,CM,code('baseline_state_changed'),'a cutover ledger over a strict-verified baseline');
 // from loading (a started load) the explicit path records as well
 const loading=database();
 await B.markBaselineLoading(env(loading),{reference:'run-1',expectedGeneration:0,at:AT});
 assert.equal((await record(loading,good,CM,{at:LATER})).already,false);
 assert.deepEqual(rowOf(loading),{state:'verified',reference:REFERENCE,updated_at:LATER});
}

// 3. the path is chosen by the caller, by exact name and version: no other value selects a path, and none falls back to strict
{
 const file=database();
 const pass=await strict();
 for(const bad of ['cutover_minimum','strict',null,true,1,[],['cutover_minimum',1],{},{gate:'cutover_minimum'},{gate:'cutover_minimum',version:2},{gate:'cutover_minimum',version:'1'},{gate:'cutover_minimum',version:1,waiver:'any'},{gate:'strict',version:2},{gate:'other',version:1},{gate:'cutover_minimum_v2',version:1}]){
  await refuses(file,good,bad,code('baseline_path_invalid'),'path '+JSON.stringify(bad));
  await refuses(file,pass,bad,code('baseline_path_invalid'),'an unknown path does not fall back to strict: '+JSON.stringify(bad));
 }
 // the cutover path does not fall back to the strict gate: a ledger only the strict gate passes is refused there
 await refuses(file,pass,CM,gateFailed('cutover_minimum_missing'),'a strict-only ledger on the cutover path');
 assert.deepEqual(rowOf(file),EMPTY);
 // the arguments are validated before the path
 await refuses(file,good,CM,code('baseline_invalid'),'generation',{expectedGeneration:'0'});
 await refuses(file,good,CM,code('baseline_invalid'),'time',{at:null});
}

// 4. a failing gate writes nothing: each defect on its own, on the explicit path
{
 const file=database();
 const base=inputs();
 const failing=[
  ['source_unverified',await cutover({source:{aggregateSha256:SRC,verified:false,kind:'projector-input-capture'}})],
  ['source_unverified',await cutover({source:{aggregateSha256:SRC,verified:'true'}})],
  ['source_unverified',await cutover({source:{aggregateSha256:'not-a-digest',verified:true}})],
  ['source_unverified',await cutover({source:null})],
  ['source_manifest_mismatch',await cutover({evidence:{...base.evidence,manifestDigest:await sha256Hex('another')}})],
  ['fence_or_lease_lost',await cutover({evidence:{...base.evidence,fenceHeld:false}})],
  ['fence_or_lease_lost',await cutover({evidence:{...base.evidence,leaseLost:true}})],
  ['r2_etags_changed',await cutover({evidence:{...base.evidence,r2Etags:{before:ETAGS,after:await sha256Hex('moved')}}})],
  ['r2_etags_missing',await cutover({evidence:{...base.evidence,r2Etags:null}})],
  ['d1_identity_changed',await cutover({evidence:{...base.evidence,d1:{before:identity(0),after:identity(1)}}})],
  ['d1_identity_changed',await cutover({evidence:{...base.evidence,d1:{before:identity(),after:{...identity(),published:{generation:8}}}}})],
  ['witness_moved',await cutover({evidence:{...base.evidence,witness:{before:witness,after:{...witness,film:'{"n":3}'}}}})],
  ['probe_incomplete',await cutover({evidence:{...base.evidence,probeComplete:false}})],
  ['incomplete',await cutover({actual:{...base.actual,complete:false}})],
  ['inconsistent_read',await cutover({actual:{...base.actual,consistent:false}})],
  ['class_unavailable:credit',await cutover({actual:{...base.actual,unavailable:['credit']}})],
  ['unexplained:film',await cutover({actual:{...base.actual,classes:{...base.actual.classes,film:[[keyOf('film','k1'),'["DIFFERENT"]'],[keyOf('film','k2'),'["w"]']]}}})],
  ['owner_review_facts_changed',await cutover({ownerLink:{...base.ownerLink,factsAfter:{count:2,digest:await sha256Hex('changed')}}})],
  // an unauthorized waiver: free text, another class, another approver, an extra one, none
  ['waiver_not_permitted',await cutover({waivers:[{...OWNER_LINK_WAIVER,decision:'the owner said it is fine'}]})],
  ['waiver_not_permitted',await cutover({waivers:[{id:'x',class:'ownerLink',scope:'link_values',approver:'owner',decision:'because I say so'}]})],
  ['waiver_not_permitted',await cutover({waivers:[{...OWNER_LINK_WAIVER,class:'credit'}]})],
  ['waiver_not_permitted',await cutover({waivers:[{...OWNER_LINK_WAIVER,approver:'executor'}]})],
  ['waiver_not_permitted',await cutover({waivers:[{...OWNER_LINK_WAIVER},{...OWNER_LINK_WAIVER,class:'credit',scope:'all'}]})],
  ['waiver_missing',await cutover({waivers:[]})],
 ];
 for(const [reason,ledger] of failing){
  assert.equal((await cutoverMinimumGate(ledger)).pass,false,reason);
  await refuses(file,ledger,CM,gateFailed(reason),reason);
  // and no path records it: the strict path refuses the same ledger
  await refuses(file,ledger,undefined,code('baseline_gate_failed'),'strict: '+reason);
 }
 // an unverified source is refused even when every other part of the ledger passes, and the refusal names it
 const unverified=failing[0][1];
 assert.deepEqual((await cutoverMinimumGate(unverified)).reasons,['source_unverified']);
 // a malformed ledger
 for(const [reason,ledger] of [['ledger_version',null],['ledger_version',undefined],['ledger_version',{}],['ledger_version','ledger'],['ledger_version',{version:2}],['cutover_minimum_missing',{version:1,classes:{}}],['cutover_minimum_missing',{...good,cutoverMinimum:{...good.cutoverMinimum,version:2}}]])await refuses(file,ledger,CM,gateFailed(reason),'malformed: '+reason);
 // a tampered digest, and tampering that recomputes the digest
 const tampered=[];
 {const ledger=await cutover();ledger.cutoverDigest='0'.repeat(64);tampered.push(['cutover_digest_mismatch',ledger]);}
 {const ledger=await cutover();delete ledger.cutoverDigest;tampered.push(['cutover_digest_mismatch',ledger]);}
 {const ledger=await cutover();ledger.digest='0'.repeat(64);tampered.push(['digest_mismatch',ledger]);}
 {const ledger=await cutover({source:{aggregateSha256:SRC,verified:false}});ledger.source.verified=true;tampered.push(['digest_mismatch',ledger]);}
 {const ledger=await cutover();ledger.totals.unexplained=1;tampered.push(['digest_mismatch',ledger]);}
 {const ledger=await cutover({evidence:{...base.evidence,leaseLost:true}});ledger.cutoverMinimum.source.leaseLost=false;tampered.push(['cutover_digest_mismatch',ledger]);}
 {const ledger=await cutover();ledger.cutoverMinimum.waivers=[{...OWNER_LINK_WAIVER,decision:'forged'}];tampered.push(['cutover_digest_mismatch',ledger]);}
 {const ledger=await cutover();ledger.cutoverMinimum.waivers=[{...OWNER_LINK_WAIVER,decision:'forged'}];await redigest(ledger);tampered.push(['waiver_not_permitted',ledger]);}
 {const ledger=await cutover();ledger.totals.unexplained=1;ledger.digest=await ledgerDigest(ledger);await redigest(ledger);tampered.push(['unexplained_total',ledger]);}
 {const ledger=await cutover();ledger.cutoverMinimum.notProved=[];await redigest(ledger);tampered.push(['not_proved_mismatch',ledger]);}
 for(const [reason,ledger] of tampered)await refuses(file,ledger,CM,gateFailed(reason),'tampered: '+reason);
 assert.deepEqual(rowOf(file),EMPTY,'after every refusal the baseline row is still empty');
 assert.deepEqual(markerOf(file),{mode:'r2',cutover:'open',generation:0});
 // the same database still records the good ledger: the refusals left no state behind
 assert.equal((await record(file,good,CM)).already,false);
}

// 5. the ledger is bound to the generation it is recorded at, and the marker must be r2 at that generation
{
 const moved=database();
 for(const trigger of rows(moved,"SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='film_person_authority'"))sql(moved,'DROP TRIGGER '+trigger.name+';');
 sql(moved,'UPDATE film_person_authority SET generation=2');
 // measured at generation 0, the marker is now at 2: refused whichever generation the caller names
 await refuses(moved,good,CM,gateFailed('ledger_generation_mismatch'),'a ledger of another generation',{expectedGeneration:2});
 await refuses(moved,good,CM,code('baseline_marker_not_r2'),'the caller names the old generation',{expectedGeneration:0});
 await refuses(moved,good,CM,gateFailed('ledger_generation_mismatch'),'a generation nobody measured',{expectedGeneration:1});
 // a ledger measured while the marker was not r2, and one whose identity carries no marker
 const base=inputs();
 await refuses(moved,await cutover({evidence:{...base.evidence,d1:{before:identity(2,'prepared'),after:identity(2,'prepared')}}}),CM,gateFailed('ledger_generation_mismatch'),'measured in prepared',{expectedGeneration:2});
 const bare={schema:{version:18}};
 await refuses(moved,await cutover({evidence:{...base.evidence,d1:{before:bare,after:bare}}}),CM,gateFailed('ledger_generation_mismatch'),'no marker in the identity',{expectedGeneration:2});
 assert.deepEqual(rowOf(moved),EMPTY);
 // measured at generation 2, it records at generation 2
 const at2=await cutover({evidence:{...base.evidence,d1:{before:identity(2),after:identity(2)}}});
 assert.equal((await record(moved,at2,CM,{expectedGeneration:2})).reference,'cutover_minimum/v1:'+at2.cutoverDigest);
 // a marker beyond r2 refuses the explicit path as it refuses the strict one
 const prepared=database();
 sql(prepared,"UPDATE film_person_baseline SET state='loading',reference='t';UPDATE film_person_baseline SET state='verified';UPDATE film_person_authority SET mode='prepared',generation=1");
 const at1=await cutover({evidence:{...base.evidence,d1:{before:identity(1),after:identity(1)}}});
 await refuses(prepared,at1,CM,code('baseline_marker_not_r2'),'the marker is prepared',{expectedGeneration:1});
 // a race between the read and the batch: the marker moves, nothing is recorded
 const racing=database();
 const raceEnv={DB:d1Standin(racing,{onBatch:async()=>{sql(racing,"UPDATE film_person_baseline SET state='loading',reference='t';UPDATE film_person_baseline SET state='verified';UPDATE film_person_authority SET mode='prepared',generation=1");}})};
 await assert.rejects(()=>recordBaselineVerified(raceEnv,{ledger:good,expectedGeneration:0,at:AT,path:CM}),code('baseline_marker_not_r2'));
 assert.equal(rowOf(racing).reference,'t','the batch recorded nothing');
}

// 6. an unknown outcome of the batch: the replay settles it by reading the row and records exactly once
{
 // the batch commits and its answer is lost
 const lost=database();
 const standin=d1Standin(lost);
 let batches=0;
 const flaky={DB:{prepare:sqlText=>standin.prepare(sqlText),batch:async statements=>{batches++;const out=await standin.batch(statements);if(batches===1)throw new Error('connection reset');return out;}}};
 await assert.rejects(()=>recordBaselineVerified(flaky,{ledger:good,expectedGeneration:0,at:AT,path:CM}),code('film_person_unavailable'));
 assert.deepEqual(rowOf(lost),{state:'verified',reference:REFERENCE,updated_at:AT},'the write had landed');
 assert.deepEqual(await recordBaselineVerified(flaky,{ledger:good,expectedGeneration:0,at:LATER,path:CM}),{state:'verified',reference:REFERENCE,already:true});
 assert.equal(batches,1,'the replay sent no second batch');
 assert.deepEqual(rowOf(lost),{state:'verified',reference:REFERENCE,updated_at:AT});
 // the batch never reaches the database
 const never=database();
 const standin2=d1Standin(never);
 let attempts=0;
 const down={DB:{prepare:sqlText=>standin2.prepare(sqlText),batch:async statements=>{if(++attempts===1)throw new Error('connection refused');return standin2.batch(statements);}}};
 await assert.rejects(()=>recordBaselineVerified(down,{ledger:good,expectedGeneration:0,at:AT,path:CM}),code('film_person_unavailable'));
 assert.deepEqual(rowOf(never),EMPTY);
 assert.deepEqual(await recordBaselineVerified(down,{ledger:good,expectedGeneration:0,at:LATER,path:CM}),{state:'verified',reference:REFERENCE,already:false});
 assert.deepEqual(rowOf(never),{state:'verified',reference:REFERENCE,updated_at:LATER});
 assert.equal(attempts,2);
}

// 7. static: the recorder reaches the gate only inside the explicit path, and the gate module still writes nothing
{
 const text=fs.readFileSync('src/film-person-baseline.js','utf8').replace(/\/\/.*$/gm,'');
 assert.equal((text.match(/film-person-cutover-minimum/g)||[]).length,1,'one reference to the gate module');
 assert.match(text,/await import\('\.\/film-person-cutover-minimum\.js'\)/,'loaded dynamically, inside the explicit path');
 assert.doesNotMatch(text,/^import[^;]*film-person-cutover-minimum/m,'no static import of the gate');
 assert.equal((text.match(/UPDATE film_person_baseline SET state='verified'/g)||[]).length,1,'one statement records a verified baseline');
 const gate=fs.readFileSync('src/film-person-cutover-minimum.js','utf8').replace(/\/\/.*$/gm,'');
 assert.doesNotMatch(gate,/\b(INSERT|UPDATE|DELETE)\b|\.batch\(|\.run\(|prepare\(/,'the gate module issues no statement');
 assert.doesNotMatch(gate,/recordBaselineVerified|markBaselineLoading/,'the gate module never calls a recorder');
}
console.log('film-person-cutover-record: ok');
