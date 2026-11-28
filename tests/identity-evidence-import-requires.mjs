// AIR-622 / ADR 0215 decision 7 amendment (owner disposition: option A): a D1 source record may name up to MAX_REQUIRES ADDITIONAL rows it depends on (`requires`), carried inside the
// existing `guard_json` object (reserved key `$requires`), covered by the manifest digest and asserted by separate statements in the SAME atomic chunk batch. On the sqlite3-CLI D1 stand-in.
// Covered: a source WITHOUT requires is byte-for-byte what it was (golden digest, tokens and guard JSON captured from the code before the amendment); validation (bounds, closed allowlist,
// duplicates, nesting, size, the two forms); canonical order; the digest covers requires; contradictory descriptors are a reported source conflict; the exact round trip through the
// staging; every required row mutated or deleted after the seal fails ITS chunk as `source_moved` with zero ledger rows and zero receipts; the statement and bind bounds.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import * as Import from '../src/identity-evidence-import.js';

const {planManifest,validateManifest,loadAndSealManifest,importRun,readImportRun,readStagedManifest,manifestDigest,chunkStatements,guardCondition,requiredConditions,MAX_REQUIRES,REQUIRES_KEY,MAX_GUARD_JSON}=Import;

const NEW='0044_identity_evidence_reconstruction_import.sql';
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const chain=files.slice(0,files.indexOf(NEW)+1);
const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-import-requires-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const read=name=>fs.readFileSync('migrations/'+name,'utf8');
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rowsOf=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rowsOf(file,text)[0]||{})[0];
const ok=(file,text)=>{const r=sqlite(file,text);assert.equal(r.status,0,r.stderr+' <- '+text);};
const lit=value=>value===null||value===undefined?'NULL':typeof value==='number'?String(value):"'"+String(value).replace(/'/g,"''")+"'";
const template=path.join(root,'template.sqlite');
ok(template,chain.map(read).join('\n'));
let n=0;
const copy=()=>{const file=path.join(root,'w-'+(n++)+'.sqlite');fs.copyFileSync(template,file);return file;};
const BASE=Date.parse('2026-11-25T10:00:00.000Z');
const at=ms=>new Date(BASE+ms).toISOString();
const COHORT=at(0);
const SEEN='2026-11-01T00:00:00.000Z';
const code=expected=>error=>{assert.equal(error.code,expected,String(error?.stack||error));return true;};
const invalidWith=reason=>error=>{assert.equal(error.code,'identity_evidence_import_invalid');assert.equal(error.reason,reason,String(error.reason));return true;};

// ---- fixtures: one source row plus the rows it depends on ----
const OBS=i=>'film '+i+'|2000';
const history=(i,revision=1)=>({table:'discovery_decision_history',key:{observation_key:OBS(i),revision},guard:{writer:'discovery_identity_correct',written_at:SEEN,'payload_json#$.ownerIdentity.tmdbId':String(100+i)}});
const intent=(id,over={})=>({table:'discovery_intent',key:{idempotency_key:id},guard:{state:'receipt',kind:'identity_reject','command_json#$.tmdbId':'222',...over}});
const evidence=i=>({subject:{kind:'discovery_observation',value:OBS(i)},relation:'candidate_for',object:{kind:'tmdb_movie',value:String(100+i)},polarity:'refutes',route:'owner_action',method:'owner_statement',sourceRoot:'intent-'+i,observedAt:SEEN,sourceOrder:1});
const record=(i,requires)=>({source:{...intent('intent-'+i),...(requires===undefined?{}:{requires})},rows:[{evidence:evidence(i)}]});
const OPTIONS={runId:'run-r',family:'a',cohortAt:COHORT,writers:['discovery_decision','discovery_owner']};
const plan=(records,over={})=>planManifest({...OPTIONS,records,...over});
const seedHistory=(file,i,revision=1)=>ok(file,'INSERT INTO discovery_decision_history (observation_key,revision,generation,written_at,writer,payload_json) VALUES ('+[OBS(i),revision,1,SEEN,'discovery_identity_correct',JSON.stringify({ownerIdentity:{tmdbId:String(100+i)}})].map(lit).join(',')+')');
const seedIntent=(file,id,extra={})=>ok(file,'INSERT INTO discovery_intent (idempotency_key,kind,state,observation_key,before_json,receipt_json,issued_json,command_json,expected_hash,expires_at,generation) VALUES ('+
 [id,'identity_reject','receipt',extra.observation||OBS(1),'{}','{"state":"applied"}','{"confirmedAt":"'+SEEN+'"}','{"effect":"reject","tmdbId":"222"}','0'.repeat(64),BASE+9000000,1].map(lit).join(',')+')');
const envOf=file=>({DB:d1Standin(file)});

// ===== 1. a source WITHOUT requires is what it always was =====
{
 const v1=i=>({source:{table:'discovery_decision_history',key:{observation_key:OBS(i),revision:1},guard:{written_at:SEEN,'payload_json#$.identitySource':'tmdb_detail'}},
  rows:[{evidence:{subject:{kind:'discovery_observation',value:OBS(i)},relation:'candidate_for',object:{kind:'tmdb_movie',value:String(100+i)},polarity:'asserts',route:'discovery_scan',method:'tmdb_detail_check',sourceRoot:OBS(i),observedAt:SEEN}}]});
 const result=await planManifest({runId:'golden',family:'a',cohortAt:'2026-11-25T10:00:00.000Z',writers:['discovery_decision','discovery_owner'],records:[v1(1),v1(2)]});
 // Captured from the module BEFORE the amendment: the digest, the source tokens and the canonical guard JSON of a v1 manifest are unchanged, so family (c) and every approved or imported manifest keep their digest.
 assert.equal(result.digest,'bfd5173997d1154b9aa24fac2a5395dea0cb9eb181259fd5405a3e894c9da83e');
 assert.deepEqual(result.manifest.chunks[0].sources.map(source=>source.token),['d1:discovery_decision_history:6c2967b0f8b62ab25d81ff34de4d632be833bf4b278aa8f88a1243133bea23e3','d1:discovery_decision_history:907342617b05687af5a84e4066d7a6fa9e5632026116a1904ab7ebeb22db987f']);
 assert.equal(JSON.stringify(result.manifest.chunks[0].sources[0].guard),'{"payload_json#$.identitySource":"tmdb_detail","written_at":"2026-11-01T00:00:00.000Z"}');
 assert.equal(Object.hasOwn(result.manifest.chunks[0].sources[0].guard,REQUIRES_KEY),false);
 assert.deepEqual(requiredConditions({kind:'d1_row',table:'discovery_intent',key:{idempotency_key:'x'},guard:{state:'receipt'}}),[],'no requires, no extra assertion');
}

// ===== 2. validation: bounded, closed allowlist, no chains, no duplicates, bounded size =====
{
 await plan([record(1,[history(1)])]);   // a valid one
 await assert.rejects(()=>plan([record(1,[])]),invalidWith('requires'));
 await assert.rejects(()=>plan([record(1,[history(1,1),history(1,2),history(1,3),history(1,4)])]),invalidWith('requires'),'more than MAX_REQUIRES');
 assert.equal(MAX_REQUIRES,3);
 await plan([record(1,[history(1,1),history(1,2),history(1,3)])]);
 await assert.rejects(()=>plan([record(1,[{table:'identity_evidence_import_run',key:{run_id:'x'},guard:{state:'running'}}])]),invalidWith('requires_table'),'the closed allowlist');
 await assert.rejects(()=>plan([record(1,[{...history(1),extra:true}])]),invalidWith('requires'));
 await assert.rejects(()=>plan([record(1,[{...history(1),guard:{...history(1).guard,[REQUIRES_KEY]:[history(2)]}}])]),invalidWith('requires_nested'),'no chains');
 await assert.rejects(()=>plan([record(1,[{...history(1),guard:{'payload_json#$.x.y':{nested:1},written_at:SEEN}}])]),invalidWith('guard_value'),'scalar guard values only');
 await assert.rejects(()=>plan([record(1,[{...history(1),guard:{no_such_column:1}}])]),invalidWith('guard_column'));
 await assert.rejects(()=>plan([record(1,[{...history(1),key:{observation_key:OBS(1)}}])]),invalidWith('source_key'),'every key column');
 await assert.rejects(()=>plan([record(1,[history(1),history(1)])]),invalidWith('requires_duplicate'));
 await assert.rejects(()=>plan([record(1,[intent('intent-1')])]),invalidWith('requires_duplicate'),'a row cannot require itself');
 const both={source:{...intent('intent-1'),requires:[history(1)],guard:{...intent('intent-1').guard,[REQUIRES_KEY]:[history(1)]}},rows:[{evidence:evidence(1)}]};
 await assert.rejects(()=>plan([both]),invalidWith('requires_twice'));
 // The descriptor must fit the guard_json column (4000 characters): a larger one is refused before anything is staged.
 const big=i=>({table:'discovery_decision_history',key:{observation_key:OBS(1),revision:i},guard:Object.fromEntries(Array.from({length:40},(_,k)=>['payload_json#$.f'+k+'xxxxxxxxxxxxxxxxxxxx',('v'.repeat(40))+k]))});
 await assert.rejects(()=>plan([record(1,[big(1),big(2),big(3)])]),invalidWith('guard_size'));
 assert.equal(MAX_GUARD_JSON,4000);
}

// ===== 3. canonical order, the digest covers requires, contradictory descriptors are a reported conflict =====
{
 const a=await plan([record(1,[history(1,1),history(1,2)])]);
 const b=await plan([record(1,[history(1,2),history(1,1)])]);
 assert.equal(a.digest,b.digest,'the order of requires is canonical');
 const without=await plan([record(1)]);
 assert.notEqual(a.digest,without.digest,'requires is covered by the digest');
 assert.notEqual((await plan([record(1,[history(1,1)])])).digest,(await plan([record(1,[history(1,2)])])).digest,'a different required row is a different manifest');
 assert.notEqual((await plan([record(1,[history(1,1)])])).digest,(await plan([record(1,[{...history(1,1),guard:{...history(1,1).guard,written_at:'2026-01-01T00:00:00.000Z'}}])])).digest,'a different required guard is a different manifest');
 // Two inputs of ONE source that disagree on its requires never merge (first-wins is never used on contradictory data).
 const conflict=await plan([record(1,[history(1,1)]),record(1,[history(1,2)])]);
 assert.equal(conflict.report.conflicts.some(item=>item.reason==='source_descriptor'),true);assert.equal(conflict.manifest,null);
 // And the token of a source is unchanged by requires (it names the row, not its dependencies).
 assert.equal(a.manifest.chunks[0].sources[0].token,without.manifest.chunks[0].sources[0].token);
 assert.deepEqual(validateManifest(a.manifest).chunks[0].sources[0].guard[REQUIRES_KEY].map(item=>item.key.revision),[1,2]);
}

// ===== 4. the staging round trip is exact, inside the existing column =====
{
 const file=copy();seedIntent(file,'intent-1');seedHistory(file,1,1);seedHistory(file,1,2);
 const result=await plan([record(1,[history(1,1),history(1,2)])]);
 const env=envOf(file);
 await loadAndSealManifest(env,{manifest:result.manifest,approvedDigest:result.digest,now:at(1000)});
 const staged=await readStagedManifest(env,'run-r');
 assert.deepEqual(staged,result.manifest,'exact round trip through the staging');
 assert.equal(await manifestDigest(staged),result.digest);
 const stored=one(file,'SELECT guard_json FROM identity_evidence_import_source');
 assert.equal(stored.includes('"'+REQUIRES_KEY+'"'),true);assert.equal(stored.length<=MAX_GUARD_JSON,true);
}

// ===== 5. each required row is asserted in the SAME atomic chunk: mutated or deleted after the seal, the chunk fails as source_moved with zero writes =====
const cases=[
 ['the primary row deleted','DELETE FROM discovery_intent'],
 ['the primary guard field changed',"UPDATE discovery_intent SET command_json=json_set(command_json,'$.tmdbId','999')"],
 ['the first required row deleted','DELETE FROM discovery_decision_history WHERE revision=1'],
 ['the second required row deleted','DELETE FROM discovery_decision_history WHERE revision=2'],
 ['a required row writer changed',"UPDATE discovery_decision_history SET writer='owner' WHERE revision=2"],
 ['a required row written_at changed',"UPDATE discovery_decision_history SET written_at='2026-01-01T00:00:00.000Z' WHERE revision=1"],
 ['a required row payload field changed',"UPDATE discovery_decision_history SET payload_json=json_set(payload_json,'$.ownerIdentity.tmdbId','999') WHERE revision=2"],
];
for(const [name,change] of cases){
 const file=copy();seedIntent(file,'intent-1');seedHistory(file,1,1);seedHistory(file,1,2);
 const result=await plan([record(1,[history(1,1),history(1,2)])]);
 const env=envOf(file);
 await loadAndSealManifest(env,{manifest:result.manifest,approvedDigest:result.digest,now:at(1000)});
 ok(file,change);
 await assert.rejects(()=>importRun(env,{runId:'run-r',approvedDigest:result.digest,owner:'operator-a',now:at(2000)}),code('identity_evidence_import_source_moved'),name);
 const run=await readImportRun(env,'run-r');
 assert.deepEqual([run.state,run.stopReason],['stopped','source_moved'],name);
 assert.equal(one(file,'SELECT COUNT(*) FROM film_identity_evidence'),0,name+': no ledger row');
 assert.equal(one(file,'SELECT COUNT(*) FROM identity_evidence_import_receipt'),0,name+': no receipt');
}
{
 // Unchanged dependencies: the same manifest imports, one row inserted, the four counts add up.
 const file=copy();seedIntent(file,'intent-1');seedHistory(file,1,1);seedHistory(file,1,2);
 const result=await plan([record(1,[history(1,1),history(1,2)])]);
 const env=envOf(file);
 await loadAndSealManifest(env,{manifest:result.manifest,approvedDigest:result.digest,now:at(1000)});
 const done=await importRun(env,{runId:'run-r',approvedDigest:result.digest,owner:'operator-a',now:at(2000)});
 assert.equal(done.state,'complete');assert.equal(one(file,'SELECT COUNT(*) FROM film_identity_evidence'),1);
}

// ===== 6. the statement and bind bounds: a separate assertion per required row, inside the batch limits =====
{
 const records=Array.from({length:50},(_,i)=>record(i+1,[history(i+1,1),history(i+1,2),history(i+1,3)]));
 const result=await plan(records);
 assert.equal(result.report.counts.chunks,1,'50 sources with 3 requires each still make one chunk');
 const [chunk]=result.manifest.chunks;
 const statements=chunkStatements({run:{runId:'run-r',manifestSha256:result.digest},chunk,attempt:1,at:at(0)});
 assert.equal(statements.length,5+50*4,'one assertion per source and one per required row, plus the five fixed statements');
 assert.equal(statements.length<=2000,true,'within the batch statement limit');
 assert.equal(Math.max(...statements.map(([,params])=>params.length))<=100,true,'within the per-statement bind limit');
 for(const source of chunk.sources)assert.equal(requiredConditions(source).length,3);
 assert.equal(guardCondition(chunk.sources[0]).params.length<=100,true);
}
console.log('identity evidence import requires tests passed');
