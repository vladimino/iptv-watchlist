// AIR-693: migration 0053, verified other-language tags in the per-field provenance (ADR 0214 decisions 2 and 9; ADR 0224 P1-A). Offline only: scratch sqlite databases built from the real chain; nothing is applied anywhere. Synthetic ids only.
//  - the chain 52 -> 53, its refusals (a wrong predecessor, a second apply, a database that is not the 0049 shape) and that a refusal changes nothing;
//  - a POPULATED version 52 database keeps every row (field rows, history with its ids, command, control) and every trigger with its 0049 text, index and table option; no temporary object stays;
//  - the widened constraint: a normalized two-letter tag on synopsis and poster, on the field row and on both history sides, and every other shape, field and `assumed` rule still refused;
//  - the behaviour of 0049 after the rebuild (invalidation, locks, immutability, the protection signal) on raw statements.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {migrated} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const M53=fs.readFileSync('migrations/0053_provenance_other_language.sql','utf8');
const run=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<28});
const exec=(file,text)=>{const result=run(file,text);if(result.status!==0)throw new Error(result.stderr);return String(result.stdout);};
const rows=(file,text)=>{const result=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr);const out=String(result.stdout).trim();return out?JSON.parse(out):[];};
const fails=(file,text,pattern)=>{const result=run(file,text);assert.notEqual(result.status,0,'must be refused: '+text.slice(0,110));if(pattern)assert.match(String(result.stderr),pattern);};
const version=file=>Number(rows(file,'SELECT version FROM schema_contract WHERE id=1')[0].version);
const dump=file=>{const result=sqliteSync([file,'.dump'],{encoding:'utf8',maxBuffer:1<<30});if(result.status!==0)throw new Error(result.stderr);return String(result.stdout).split('\n');};
let copies=0;
const copyOf=(file,name)=>{const target=file.replace(/\.sqlite$/,'-'+name+'-'+(copies++)+'.sqlite');fs.copyFileSync(file,target);return target;};
const T='2026-11-27T10:00:00.000Z';
const H='a'.repeat(64);
const FILM=id=>`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('${id}',2,NULL,'T','${T}');`;
const META=id=>`INSERT INTO film_metadata (film_id,schema_version,year,runtime,synopsis,poster,url,genres_json,people_version,payload_json,r2_key,content_sha256,updated_at) VALUES ('${id}',1,1999,136,'S','/p','https://e.test',${"'[\"a\"]'"},NULL,'{}',NULL,NULL,'${T}');`;
const FIELD=(id,name,over={})=>{
 const base={film_id:id,field:name,tier:'automatic',source:'tmdb',origin:'catalog_enrichment',anchor_scheme:'tmdb',anchor_value:'603',anchor_digest:H,agreement:'confirmed',observed_at:T,checked_at:T,value_digest:H,write_key:'k',written_revision:1,updated_at:T,...over};
 const cols=Object.keys(base),val=value=>value===null?'NULL':typeof value==='number'?String(value):"'"+value+"'";
 return `INSERT INTO film_metadata_field (${cols.join(',')}) VALUES (${cols.map(key=>val(base[key])).join(',')});`;
};
const HIST=(key,over={})=>{
 const base={film_id:'film:a',field:'poster',reason:'replaced',write_key:key,at:T,...over};
 const cols=Object.keys(base),val=value=>value===null?'NULL':"'"+value+"'";
 return `INSERT INTO film_metadata_history (${cols.join(',')}) VALUES (${cols.map(key2=>val(base[key2])).join(',')});`;
};
const TABLES=['film_metadata_field','film_metadata_history','film_metadata_owner_command','film_metadata_owner_release','film_metadata_provenance_control'];
const data=file=>Object.fromEntries(TABLES.map(name=>[name,rows(file,`SELECT * FROM ${name} ORDER BY ${name==='film_metadata_field'?'film_id,field':name==='film_metadata_history'?'id':'1'}`)]));
const triggers=file=>Object.fromEntries(rows(file,"SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").map(row=>[row.name,row]));

// ---- 1. the chain and the refusals ----
const v49=migrated(49),v52=migrated(52);
assert.equal(version(v49),49);assert.equal(version(v52),52);
{
 const before=dump(v49);
 assert.notEqual(run(v49,M53).status,0,'on version 49 the file aborts');
 assert.deepEqual(dump(v49),before,'and the whole state is unchanged');
}
const v53=migrated(53);
assert.equal(version(v53),53);
{
 const again=copyOf(v53,'again'),before=dump(again);
 assert.notEqual(run(again,M53).status,0,'a second apply is refused');
 assert.deepEqual(dump(again),before,'and changes nothing');
 fails(copyOf(v53,'down'),'UPDATE schema_contract SET version=52 WHERE id=1');
 // a database whose tables are not the 0049 shape (here: a missing history trigger) is refused before any object changes
 const odd=copyOf(v52,'odd');exec(odd,'DROP TRIGGER film_metadata_history_no_update');
 const oddBefore=dump(odd);assert.notEqual(run(odd,M53).status,0,'a changed 0049 object set is refused');assert.deepEqual(dump(odd),oddBefore);
}

// ---- 2. a populated version 52 database keeps everything ----
{
 const file=copyOf(v52,'pop');
 exec(file,FILM('film:a')+META('film:a'));
 exec(file,"UPDATE film_metadata_provenance_control SET mode='enforce',revision=2,updated_at='"+T+"',updated_by='test' WHERE id=1");
 exec(file,FIELD('film:a','year')+FIELD('film:a','synopsis',{language:'en',language_basis:'assumed',source:'letterboxd',anchor_scheme:'letterboxd',anchor_value:'lid1'})+FIELD('film:a','poster',{language:'ru',language_basis:'explicit'})+FIELD('film:a','runtime',{tier:'owner',source:'owner',origin:'owner_route',agreement:null,anchor_scheme:null,anchor_value:null}));
 exec(file,HIST('h1',{old_language:'ru',old_language_basis:'explicit',new_language:'en',new_language_basis:'explicit',old_value_text:'"x"'})+HIST('h2',{field:'year',reason:'cleared'})+HIST('h3',{field:'synopsis',old_language:'en',old_language_basis:'assumed',old_source:'letterboxd'}));
 exec(file,`INSERT INTO film_metadata_owner_command (request_id,film_id,action,command_digest,outcome,applied_revision,at) VALUES ('c1','film:a','set','${H}','applied',2,'${T}')`);
 const before=data(file),beforeTriggers=triggers(file),beforeIndexes=rows(file,"SELECT name,tbl_name FROM sqlite_master WHERE type='index' ORDER BY name"),beforeMeta=rows(file,'SELECT * FROM film_metadata');
 assert.equal(before.film_metadata_field.length,4);assert.equal(before.film_metadata_history.length,3);
 exec(file,M53);
 assert.equal(version(file),53);
 assert.deepEqual(data(file),before,'every row of every provenance table is kept, history ids included');
 assert.deepEqual(rows(file,'SELECT * FROM film_metadata'),beforeMeta,'the film metadata row is untouched');
 const after=triggers(file);
 assert.deepEqual(Object.keys(after),Object.keys(beforeTriggers),'every trigger exists again, none is added');
 for(const name of Object.keys(beforeTriggers))assert.equal(after[name].sql,beforeTriggers[name].sql,name+': the 0049 text, recreated unchanged');
 assert.deepEqual(rows(file,"SELECT name,tbl_name FROM sqlite_master WHERE type='index' ORDER BY name"),beforeIndexes,'the same indexes');
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%v53%'")[0].n,0,'no temporary object stays');
 assert.equal(rows(file,"SELECT strict FROM pragma_table_list WHERE name='film_metadata_field'")[0].strict,1,'STRICT');
 assert.equal(rows(file,"SELECT wr FROM pragma_table_list WHERE name='film_metadata_field'")[0].wr,1,'WITHOUT ROWID');
 assert.equal(rows(file,"SELECT strict FROM pragma_table_list WHERE name='film_metadata_history'")[0].strict,1);
 assert.deepEqual(rows(file,"SELECT name FROM pragma_index_list('film_metadata_field')").map(row=>row.name),['sqlite_autoindex_film_metadata_field_1'],'the primary key is still the only index');
 assert.equal(rows(file,'PRAGMA integrity_check')[0].integrity_check,'ok');assert.equal(rows(file,'PRAGMA foreign_key_check').length,0);
 // the history key still takes new rows after the copy
 exec(file,HIST('h4',{field:'year'}));assert.equal(rows(file,'SELECT MAX(id) AS m FROM film_metadata_history')[0].m,4);
 // dormant parity: the control row (mode, revision) is untouched by the rebuild
 assert.deepEqual(rows(file,'SELECT mode,revision FROM film_metadata_provenance_control'),[{mode:'enforce',revision:2}]);
}
// an empty version 52 database: empty after, control at off
{
 const file=copyOf(v52,'empty');exec(file,M53);
 for(const name of ['film_metadata_field','film_metadata_history'])assert.equal(rows(file,`SELECT COUNT(*) AS n FROM ${name}`)[0].n,0);
 assert.deepEqual(rows(file,'SELECT mode,revision FROM film_metadata_provenance_control'),[{mode:'off',revision:1}]);
}

// ---- 3. the widened constraint ----
{
 const file=copyOf(v53,'ddl');
 exec(file,FILM('film:a')+META('film:a'));
 let n=0;const key=()=>'w'+(++n);
 for(const [name,tag] of [['synopsis','fr'],['poster','fr'],['poster','de'],['synopsis','ja']]){
  exec(file,`DELETE FROM film_metadata_field WHERE film_id='film:a' AND field='${name}'`);
  exec(file,FIELD('film:a',name,{language:tag,language_basis:'explicit'}));
  assert.equal(rows(file,`SELECT language FROM film_metadata_field WHERE field='${name}'`)[0].language,tag);
 }
 const refused=/CHECK|constraint/i;
 exec(file,"DELETE FROM film_metadata_field WHERE film_id='film:a'");
 for(const tag of ['FR','Fr','fra','f','f1','1f','f ','','f-r','fr-FR','éa'])fails(file,FIELD('film:a','poster',{language:tag,language_basis:'explicit'}),refused);
 fails(file,FIELD('film:a','poster',{language:'fr'}),refused);                                  // no basis
 fails(file,FIELD('film:a','poster',{language_basis:'explicit'}),refused);                       // no language
 fails(file,FIELD('film:a','year',{language:'fr',language_basis:'explicit'}),refused);          // a field with no language
 fails(file,FIELD('film:a','url',{language:'fr',language_basis:'explicit'}),refused);
 fails(file,FIELD('film:a','synopsis',{language:'fr',language_basis:'assumed',source:'letterboxd',anchor_scheme:'letterboxd',anchor_value:'l'}),refused);   // assumed is English of a Letterboxd synopsis only
 fails(file,FIELD('film:a','poster',{language:'en',language_basis:'assumed',source:'letterboxd',anchor_scheme:'letterboxd',anchor_value:'l'}),refused);
 fails(file,FIELD('film:a','synopsis',{language:'en',language_basis:'assumed'}),refused);       // not Letterboxd
 exec(file,FIELD('film:a','synopsis',{language:'en',language_basis:'assumed',source:'letterboxd',anchor_scheme:'letterboxd',anchor_value:'l'}));
 fails(file,"UPDATE film_metadata_field SET language='FR' WHERE field='synopsis'",refused);
 // history, both sides
 exec(file,HIST(key(),{old_language:'fr',old_language_basis:'explicit',new_language:'ru',new_language_basis:'explicit'}));
 exec(file,HIST(key(),{field:'synopsis',old_language:'de',old_language_basis:'explicit'}));
 exec(file,HIST(key(),{new_language:'ja',new_language_basis:'explicit'}));
 for(const tag of ['FR','fra','f1',''])for(const side of ['old','new']){
  fails(file,HIST(key(),{[side+'_language']:tag,[side+'_language_basis']:'explicit'}),refused);
 }
 for(const side of ['old','new']){
  fails(file,HIST(key(),{field:'year',[side+'_language']:'fr',[side+'_language_basis']:'explicit'}),refused);
  fails(file,HIST(key(),{[side+'_language']:'fr'}),refused);
  fails(file,HIST(key(),{field:'synopsis',[side+'_language']:'fr',[side+'_language_basis']:'assumed',[side+'_source']:'letterboxd'}),refused);
 }
}

// ---- 4. the behaviour of 0049 after the rebuild ----
{
 const file=copyOf(v53,'raw');
 exec(file,FILM('film:a')+META('film:a'));
 exec(file,FIELD('film:a','year')+FIELD('film:a','poster',{language:'fr',language_basis:'explicit'}));
 // invalidation: a changed value deletes only its non-owner row
 exec(file,"UPDATE film_metadata SET year=2000 WHERE film_id='film:a'");
 assert.deepEqual(rows(file,'SELECT field FROM film_metadata_field').map(row=>row.field),['poster']);
 // immutability and the pin
 exec(file,HIST('h1'));
 fails(file,"UPDATE film_metadata_history SET reason='cleared'",/film_metadata_history_append_only/);
 fails(file,'DELETE FROM film_metadata_history',/film_metadata_history_append_only/);
 exec(file,FIELD('film:a','runtime',{tier:'owner',source:'owner',origin:'owner_route',agreement:null,anchor_scheme:null,anchor_value:null}));
 fails(file,"UPDATE film_metadata_field SET tier='released' WHERE field='runtime'",/film_metadata_owner_locked/);
 fails(file,"DELETE FROM film_metadata_field WHERE field='runtime'",/film_metadata_owner_locked/);
 fails(file,FIELD('film:a','runtime',{tier:'owner',source:'owner',origin:'owner_route',agreement:null,anchor_scheme:null,anchor_value:null,write_key:'z'}).replace('INSERT','INSERT OR REPLACE'),/film_metadata_owner_locked/);
 // the lock of an enforced mode and the release row
 exec(file,"UPDATE film_metadata_provenance_control SET mode='enforce',revision=2,updated_at='"+T+"',updated_by='test' WHERE id=1");
 fails(file,"UPDATE film_metadata SET runtime=140 WHERE film_id='film:a'",/film_metadata_owner_locked/);
 exec(file,"INSERT INTO film_metadata_owner_release (film_id) VALUES ('film:a');UPDATE film_metadata SET runtime=140 WHERE film_id='film:a';DELETE FROM film_metadata_owner_release WHERE film_id='film:a'");
 // the protection-released signal
 const signals=()=>rows(file,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE kind='protection_released'")[0].n;
 const was=signals();
 exec(file,"INSERT INTO film_metadata_owner_release (film_id) VALUES ('film:a');UPDATE film_metadata_field SET tier='released',source='unattributed',origin='owner_route',anchor_scheme=NULL,anchor_value=NULL,anchor_digest=NULL,agreement=NULL WHERE field='runtime';DELETE FROM film_metadata_owner_release WHERE film_id='film:a'");
 assert.equal(signals(),was+1,'an actual release still wakes the core part');
 // a delete of the film row removes the non-owner rows
 exec(file,"DELETE FROM film_metadata WHERE film_id='film:a'");
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM film_metadata_field WHERE tier<>'owner'")[0].n,0);
}
console.log('migration 0053: ok');
