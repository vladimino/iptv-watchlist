// AIR-605: migration 0047, the Catalog Enrichment Producer schema (ADR 0211 decisions 3, 5, 6 as amended by ADR 0219 decisions 2, 3, 7, 8, 9). Offline only: scratch sqlite databases built from the real chain; nothing is
// applied anywhere. Synthetic ids only.
//  - the chain 46 -> 47 and the refusals (wrong predecessor, a second apply);
//  - the inbox key is normalized and never null, a repeated event coalesces into one row and re-arms (version token), an acknowledgement cannot pass the version;
//  - every identity emitter of the ADR 0219 matrix writes its signal in the causal statement (anchor insert / update of value, trust, conflict and owner / delete, competing owner, retirement, redirect), and a rolled-back
//    change writes none;
//  - a protection release signals only on protected -> unprotected (a NULL authority included), never on an unrelated update;
//  - the producer's own writes (film_metadata, film_person_credit, person, film_localization_source) and EPG-style updates emit NOTHING;
//  - the rated emitter writes nothing before the scope is activated and then one `admitted` signal per admission;
//  - the control moves only along activate / pause / resume and same-state bumps, never back to inactive, never deleted; a scope row change advances the common generation (and only while a control row is not inactive);
//  - `activated` is never reset; scope rows are never deleted; the state table's key, part/source and slot rules, and the unit generation table.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {migrated} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const M46=fs.readFileSync('migrations/0047_catalog_enrichment.sql','utf8');
const run=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<28});
const exec=(file,text)=>{const result=run(file,text);if(result.status!==0)throw new Error(result.stderr);return String(result.stdout);};
const rows=(file,text)=>{const result=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr);const out=String(result.stdout).trim();return out?JSON.parse(out):[];};
const fails=(file,text,pattern)=>{const result=run(file,text);assert.notEqual(result.status,0,'must be refused: '+text.slice(0,90));if(pattern)assert.match(String(result.stderr),pattern);};
const version=file=>Number(rows(file,'SELECT version FROM schema_contract WHERE id=1')[0].version);
const dump=file=>{const result=sqliteSync([file,'.dump'],{encoding:'utf8',maxBuffer:1<<30});if(result.status!==0)throw new Error(result.stderr);return String(result.stdout).split('\n');};
let copies=0;
const copyOf=(file,name)=>{const target=file.replace(/\.sqlite$/,'-'+name+'-'+(copies++)+'.sqlite');fs.copyFileSync(file,target);return target;};
const T='2026-11-26T10:00:00.000Z';
const signals=file=>rows(file,"SELECT kind,subject,source,part,version,acked_version,state,cause_ref FROM enrichment_signal ORDER BY kind,subject,source,part");
const keys=file=>signals(file).map(item=>item.kind+'|'+item.subject+'|'+item.source+'|'+item.part+'|v'+item.version);
const DIM=(film,dimension,status,authority)=>`INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,last_error,failure_reason,retry_at,attempts,next_action,updated_at) VALUES ('${film}','${dimension}','${status}',NULL,NULL,NULL,NULL,${authority?`'${authority}'`:'NULL'},NULL,NULL,NULL,0,'none','${T}');`;
const FILMS=`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:a',2,NULL,'A','${T}'),('film:b',2,NULL,'B','${T}'),('film:c',2,NULL,'C','${T}');`;

// ---- 1. the chain and the refusals ----
const v46=migrated(46);
assert.equal(version(v46),46);
assert.ok(rows(v46,"SELECT name FROM sqlite_master WHERE name LIKE 'catalog_enrichment_%' OR name='enrichment_signal'").length===0,'version 46 has none of the objects');
{
 const v45=migrated(45),before=dump(v45);
 assert.notEqual(run(v45,M46).status,0,'on version 45 the file aborts');
 assert.deepEqual(dump(v45),before,'and the whole state is unchanged');
}
const db=migrated();
assert.equal(version(db),47);
{
 const again=copyOf(db,'again'),before=dump(again);
 assert.notEqual(run(again,M46).status,0,'a second apply is refused');
 assert.deepEqual(dump(again),before,'and changes nothing');
}
assert.equal(rows(db,'SELECT COUNT(*) AS n FROM enrichment_signal')[0].n,0,'created empty');
for(const table of ['catalog_enrichment_scope','catalog_enrichment_member','catalog_enrichment_state','catalog_enrichment_unit_generation','catalog_enrichment_tick','catalog_enrichment_control'])assert.equal(rows(db,`SELECT COUNT(*) AS n FROM ${table}`)[0].n,0,table+' is created empty');
// the downgrade guard of the contract still holds
fails(copyOf(db,'down'),'UPDATE schema_contract SET version=46 WHERE id=1');

// ---- 2. the inbox: normalized key, coalescing, version token ----
{
 const file=copyOf(db,'inbox');
 exec(file,`INSERT INTO enrichment_signal (kind,subject,state,version,armed_at) VALUES ('admitted','tmdb:7','pending',1,'${T}');`);
 const row=rows(file,'SELECT source,part,acked_version FROM enrichment_signal')[0];
 assert.deepEqual([row.source,row.part,row.acked_version],['','',0],'source and part default to the empty string, never NULL');
 fails(file,`INSERT INTO enrichment_signal (kind,subject,state,version,armed_at) VALUES ('admitted','tmdb:7','pending',1,'${T}');`,/UNIQUE/);
 fails(file,`INSERT INTO enrichment_signal (kind,subject,source,part,state,version,armed_at) VALUES ('admitted','tmdb:8',NULL,'','pending',1,'${T}');`,/NOT NULL/);
 fails(file,`INSERT INTO enrichment_signal (kind,subject,state,version,armed_at) VALUES ('nope','tmdb:9','pending',1,'${T}');`);
 fails(file,`UPDATE enrichment_signal SET acked_version=2 WHERE subject='tmdb:7'`);
 exec(file,`UPDATE enrichment_signal SET acked_version=1,state='consumed' WHERE subject='tmdb:7'`);
}

// ---- 3. identity emitters ----
{
 const file=copyOf(db,'anchors');
 exec(file,FILMS);
 assert.deepEqual(keys(file),[],'films alone emit nothing');
 exec(file,"INSERT INTO film_external_id VALUES ('film:a','tmdb','10',1,0,NULL);");
 assert.deepEqual(keys(file),['anchor_changed|film:a||'+'|v1'],'a trusted tmdb claim signals its Film');
 exec(file,"INSERT INTO film_external_id VALUES ('film:b','tmdb','10',0,0,NULL);");
 assert.deepEqual(keys(file),['anchor_changed|film:a||'+'|v2','anchor_changed|film:b||'+'|v1'],'a competing holder of the same value signals the first holder too (old and new)');
 exec(file,"UPDATE film_external_id SET trusted=0 WHERE film_id='film:a' AND scheme='tmdb';");
 assert.deepEqual(keys(file),['anchor_changed|film:a||'+'|v3','anchor_changed|film:b||'+'|v2'],'a trust change signals the holder and every other holder');
 exec(file,"INSERT INTO film_external_id VALUES ('film:c','letterboxd','abc',1,0,NULL);");
 exec(file,"UPDATE film_external_id SET provenance_json='{}' WHERE film_id='film:c';");
 assert.equal(signals(file).find(item=>item.subject==='film:c').version,1,'an update of an unrelated column (provenance) does not re-arm');
 exec(file,"UPDATE film_external_id SET conflicting=1 WHERE film_id='film:c';");
 assert.equal(signals(file).find(item=>item.subject==='film:c').version,2,'a conflict flag change re-arms');
 exec(file,"DELETE FROM film_external_id WHERE film_id='film:c';");
 assert.equal(signals(file).find(item=>item.subject==='film:c').version,3,'a delete re-arms');
 exec(file,"INSERT INTO film_external_id VALUES ('film:c','imdb','tt1',1,0,NULL);DELETE FROM film_external_id WHERE scheme='imdb';");
 assert.equal(signals(file).find(item=>item.subject==='film:c').version,3,'a scheme that is not an anchor emits nothing');
 const before=keys(file);
 fails(file,"BEGIN;INSERT INTO film_external_id VALUES ('film:a','letterboxd','zzz',1,0,NULL);INSERT INTO film_external_id VALUES ('film:zzz','letterboxd','y',1,0,NULL);COMMIT;");
 assert.deepEqual(keys(file),before,'a rolled-back change writes no signal');
 // owner change of one value: the PK moves the claim from one Film to another
 const owner=copyOf(db,'owner');
 exec(owner,FILMS+"INSERT INTO film_external_id VALUES ('film:a','tmdb','20',1,0,NULL);");
 exec(owner,"UPDATE film_external_id SET film_id='film:b' WHERE film_id='film:a' AND scheme='tmdb';");
 assert.deepEqual(keys(owner),['anchor_changed|film:a||'+'|v2','anchor_changed|film:b||'+'|v1'],'a change of owner signals the old and the new owner');
 // retirement and redirect
 const other=copyOf(db,'other');
 exec(other,FILMS+"INSERT INTO film_external_id VALUES ('film:a','tmdb','30',1,0,NULL);INSERT INTO film_external_id VALUES ('film:b','tmdb','30',0,0,NULL);");
 exec(other,"UPDATE enrichment_signal SET acked_version=version,state='consumed';");
 exec(other,"INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,input_sha256,supersedes_seq,payload_json,recorded_at) VALUES ('r1','film:a','retire','abc','30','31','{}','{\"by\":\"owner\",\"at\":\"x\",\"source\":\"y\"}','owner_request',NULL,NULL,'{}','"+T+"');");
 assert.deepEqual(signals(other).map(item=>item.subject+':'+item.state+':'+item.cause_ref),['film:a:pending:tmdb_retirement_decision','film:b:pending:tmdb_retirement_decision'],'a retirement signals every Film holding the id');
 exec(other,"UPDATE enrichment_signal SET acked_version=version,state='consumed';INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:b','film:c','"+T+"');");
 assert.deepEqual(signals(other).filter(item=>item.state==='pending').map(item=>item.subject),['film:b','film:c'],'a redirect signals the source and the survivor');
}

// ---- 4. protection release ----
{
 const file=copyOf(db,'protect');
 exec(file,FILMS+DIM('film:a','metadata','reviewed',null)+DIM('film:b','metadata','provisional','owner')+DIM('film:c','localization','provisional',null));
 assert.deepEqual(keys(file),[],'creating protection or non-protection emits nothing');
 exec(file,"UPDATE film_dimension SET value='x',updated_at='2026-11-27T00:00:00.000Z' WHERE film_id='film:a';");
 assert.deepEqual(keys(file),[],'an update that keeps the protection emits nothing');
 exec(file,"UPDATE film_dimension SET status='provisional' WHERE film_id='film:a';");
 assert.deepEqual(keys(file),['protection_released|film:a||metadata|v1'],'reviewed -> unprotected (authority NULL) signals the release');
 exec(file,"UPDATE film_dimension SET authority=NULL WHERE film_id='film:b';");
 assert.deepEqual(keys(file),['protection_released|film:a||metadata|v1','protection_released|film:b||metadata|v1'],'an owner pin removed signals the release');
 exec(file,"UPDATE film_dimension SET status='reviewed' WHERE film_id='film:c';UPDATE film_dimension SET status='provisional' WHERE film_id='film:c';");
 assert.equal(signals(file).find(item=>item.subject==='film:c').part,'localization','a localization release is part-specific');
 exec(file,"UPDATE film_dimension SET authority='owner' WHERE film_id='film:a';DELETE FROM film_dimension WHERE film_id='film:a';");
 assert.equal(signals(file).find(item=>item.subject==='film:a').version,2,'the delete of a protected row signals the release');
}

// ---- 5. the producer's own writes and unrelated updates emit nothing ----
{
 const file=copyOf(db,'self');
 exec(file,FILMS);
 exec(file,"INSERT INTO film_metadata (film_id,schema_version,year,genres_json,payload_json,updated_at) VALUES ('film:a',1,1999,'[]','{}','"+T+"');UPDATE film_metadata SET runtime=100 WHERE film_id='film:a';");
 exec(file,"INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:tmdb_actor/1','tmdb_actor/1',2,'"+T+"');INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES ('film:a','person:tmdb_actor/1','actor',0);");
 exec(file,"INSERT INTO film_localization_source (film_id,source,value,source_version,provenance_json,request_id,observed_at,updated_at) VALUES ('film:a','tmdb','Т','v','{}','r','"+T+"','"+T+"');");
 exec(file,"INSERT INTO film_alias (film_id,kind,value,provenance_json) VALUES ('film:a','title','x',NULL);UPDATE film SET updated_at='2026-11-27T00:00:00.000Z' WHERE id='film:a';");
 exec(file,DIM('film:a','fingerprint','provisional',null)+"UPDATE film_dimension SET status='unavailable' WHERE film_id='film:a';");
 assert.deepEqual(keys(file),[],'a complete write cycle of the producer and unrelated updates change the inbox by zero rows');
}

// ---- 6. the rated emitter is gated by the permanent `activated` flag ----
{
 const file=copyOf(db,'rated');
 const admission=(film,tmdb)=>`INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('${film}','${tmdb}','code${tmdb}','${'a'.repeat(64)}','T',2000,'k','tmdb_${tmdb}','${T}','q','${T}');`;
 exec(file,FILMS+admission('film:a','101'));
 assert.deepEqual(keys(file),[],'no scope row: an admission writes nothing');
 exec(file,"INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('rated',0,0,1,'"+T+"');"+admission('film:b','102'));
 assert.deepEqual(keys(file),[],'a scope row that is not activated: nothing');
 exec(file,"UPDATE catalog_enrichment_scope SET activated=1,enabled=0,revision=2 WHERE scope='rated';"+admission('film:c','103'));
 assert.deepEqual(keys(file),['admitted|tmdb:103|rated||v1'],'activated: one `admitted` signal, subject tmdb:<n>, source rated, even while disabled');
 fails(file,"UPDATE catalog_enrichment_scope SET activated=0 WHERE scope='rated'",/activated_once/);
 fails(file,"DELETE FROM catalog_enrichment_scope WHERE scope='rated'",/no_delete/);
 fails(file,"INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('discovery',0,1,1,'"+T+"')");
 fails(file,"INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('other',0,0,1,'"+T+"')");
}

// ---- 7. the control, and the scope fence ----
{
 const file=copyOf(db,'control');
 const control=()=>rows(file,'SELECT state,generation,revision FROM catalog_enrichment_control')[0];
 exec(file,"INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('rated',1,1,1,'"+T+"');");
 exec(file,"INSERT INTO catalog_enrichment_control VALUES (1,'inactive',0,1,'"+T+"','owner');");
 exec(file,"UPDATE catalog_enrichment_scope SET revision=2 WHERE scope='rated';");
 assert.deepEqual(control(),{state:'inactive',generation:0,revision:1},'a scope change never moves an inactive control');
 fails(file,"INSERT INTO catalog_enrichment_control VALUES (2,'inactive',0,1,'"+T+"','x')");
 fails(file,"UPDATE catalog_enrichment_control SET state='paused',generation=1,revision=2",/transition/);
 exec(file,"UPDATE catalog_enrichment_control SET state='active',generation=1,revision=2;");
 fails(file,"UPDATE catalog_enrichment_control SET state='active',generation=1,revision=3",/transition/);
 fails(file,"UPDATE catalog_enrichment_control SET state='active',generation=2,revision=2",/transition/);
 fails(file,"UPDATE catalog_enrichment_control SET state='inactive',generation=2,revision=3",/transition/);
 exec(file,"UPDATE catalog_enrichment_scope SET revision=3 WHERE scope='rated';");
 assert.deepEqual(control(),{state:'active',generation:2,revision:3},'a scope change advances the common generation');
 exec(file,"INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('c3a',1,0,1,'"+T+"');");
 assert.deepEqual(control(),{state:'active',generation:3,revision:4},'so does a new scope row');
 exec(file,"UPDATE catalog_enrichment_control SET state='paused',generation=4,revision=5;");
 exec(file,"UPDATE catalog_enrichment_scope SET enabled=0,revision=4 WHERE scope='rated';");
 assert.deepEqual(control(),{state:'paused',generation:5,revision:6},'a paused control is fenced by a scope change too and stays paused');
 exec(file,"UPDATE catalog_enrichment_control SET state='active',generation=6,revision=7;");
 fails(file,'DELETE FROM catalog_enrichment_control',/no_delete/);
 fails(file,"UPDATE catalog_enrichment_control SET generation=1,revision=9",/transition/);
}

// ---- 8. state rows, unit generation, tick ----
{
 const file=copyOf(db,'state');
 exec(file,FILMS);
 const state=(part,source,slot,status,extra='')=>`INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,due_since,updated_at${extra?',':''}${extra.split('=')[0]||''}) VALUES ('film:a','${part}','${source}',${slot},'${status}','${T}','${T}'${extra?','+extra.split('=')[1]:''});`;
 exec(file,state('film','*',0,'active')+state('core','tmdb',0,'due')+state('credits','tmdb',0,'due')+state('credits','tmdb',1,'deferred_repair')+state('localization','wikidata',0,'complete_with_gaps'));
 fails(file,state('film','tmdb',0,'active'),/CHECK/);
 fails(file,state('core','*',0,'due'),/CHECK/);
 fails(file,state('film','*',1,'active').replace("'film:a'","'film:b'"),/CHECK/);
 fails(file,state('core','tmdb',1,'due').replace("'core','tmdb'","'core','tmdb'").replace("'film:a'","'film:b'"),/CHECK/);
 fails(file,state('credits','tmdb',0,'due'),/UNIQUE/);
 fails(file,state('core','letterboxd',0,'active'),/CHECK/);
 fails(file,state('film','*',0,'due').replace("'film:a'","'film:b'"),/CHECK/);
 fails(file,state('core','discovery',0,'due'),/CHECK/);
 fails(file,state('core','tmdb',0,'bogus').replace("'film:a'","'film:c'"),/CHECK/);
 fails(file,state('core','tmdb',0,'due').replace("'film:a'","'film:missing'"),/FOREIGN/);
 exec(file,"INSERT INTO catalog_enrichment_unit_generation (unit_key,generation,history_fingerprint,updated_at) VALUES ('enrich:film:a:core',0,NULL,'"+T+"');UPDATE catalog_enrichment_unit_generation SET generation=1,history_fingerprint='100:98' WHERE unit_key='enrich:film:a:core';");
 exec(file,"INSERT INTO catalog_enrichment_tick (tick_id,started_at,state,counts_json) VALUES ('run-1','"+T+"','started','{}');UPDATE catalog_enrichment_tick SET state='finished',finished_at='"+T+"',counts_json='{\"requests\":2}' WHERE tick_id='run-1';");
 fails(file,"INSERT INTO catalog_enrichment_tick (tick_id,started_at,state,counts_json) VALUES ('run-2','"+T+"','started','not json')");
 // the due-selection index serves the head of the queue
 const plan=String(run(file,"EXPLAIN QUERY PLAN SELECT film_id FROM catalog_enrichment_state WHERE status='due' AND cohort='live' AND (retry_at IS NULL OR retry_at<='"+T+"') ORDER BY due_since LIMIT 20;").stdout);
 assert.match(plan,/catalog_enrichment_state_due/,'the due selection reads the index');
}

// ---- 9. fanout of the heaviest trigger: a value held by many Films signals each exactly once per change ----
{
 const file=copyOf(db,'fanout');
 const films=Array.from({length:40},(_,i)=>`('film:f${i}',2,NULL,'F','${T}')`).join(',');
 exec(file,`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ${films};`);
 exec(file,Array.from({length:40},(_,i)=>`INSERT INTO film_external_id VALUES ('film:f${i}','tmdb','500',0,0,NULL);`).join(''));
 assert.equal(signals(file).length,40,'one row per Film, bounded by the catalog, however many events');
 exec(file,"UPDATE film_external_id SET trusted=1 WHERE film_id='film:f0';");
 assert.ok(signals(file).every(item=>item.version>=2),'every holder was re-armed by the change');
 assert.equal(signals(file).length,40,'still one row per Film');
}
console.log('migration 0047: ok');
