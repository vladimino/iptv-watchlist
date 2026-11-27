// AIR-631: migration 0049, per-field provenance of film_metadata (ADR 0214 decisions 2, 9 and 11). Offline only: scratch sqlite databases built from the real chain; nothing is applied anywhere. Synthetic ids only.
//  - the chain 48 -> 49 and its refusals (a wrong predecessor, a second apply), created empty, the control row at `off`;
//  - every DDL constraint of `film_metadata_field`, `film_metadata_history` and `film_metadata_owner_command` (the shapes of ADR 0214 decision 2 and 9);
//  - the control row only moves along the three legal transitions, raises `revision` by one, is never deleted and has no second row;
//  - invalidation, locks and immutability on raw statements, in the order SQLite fires them (the writer behaviour is tests/film-metadata-provenance.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {migrated} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const M49=fs.readFileSync('migrations/0049_film_metadata_provenance.sql','utf8');
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
const FILM=(id,extra='')=>`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('${id}',2,NULL,'T','${T}');${extra}`;
const META=id=>`INSERT INTO film_metadata (film_id,schema_version,year,runtime,synopsis,poster,url,genres_json,people_version,payload_json,r2_key,content_sha256,updated_at) VALUES ('${id}',1,1999,136,'S','/p','https://e.test',${"'[\"a\"]'"},NULL,'{}',NULL,NULL,'${T}');`;
const FIELD=(id,name,over={})=>{
 const base={film_id:id,field:name,tier:'automatic',source:'letterboxd',origin:'catalog_enrichment',anchor_scheme:'letterboxd',anchor_value:'lid1',anchor_digest:H,agreement:'confirmed',observed_at:T,checked_at:T,value_digest:H,write_key:'k',written_revision:1,updated_at:T,...over};
 const cols=Object.keys(base),val=value=>value===null?'NULL':typeof value==='number'?String(value):"'"+value+"'";
 return `INSERT INTO film_metadata_field (${cols.join(',')}) VALUES (${cols.map(key=>val(base[key])).join(',')});`;
};

// ---- 1. the chain and the refusals ----
const v48=migrated(48);
assert.equal(version(v48),48);
assert.equal(rows(v48,"SELECT name FROM sqlite_master WHERE name LIKE 'film_metadata_field%' OR name LIKE 'film_metadata_history%' OR name LIKE 'film_metadata_owner_%' OR name LIKE 'film_metadata_provenance_%'").length,0,'version 47 has none of the objects');
{
 const v47=migrated(47),before=dump(v47);
 assert.notEqual(run(v47,M49).status,0,'on version 47 the file aborts');
 assert.deepEqual(dump(v47),before,'and the whole state is unchanged');
}
const db=migrated(49);
assert.equal(version(db),49);
{
 const again=copyOf(db,'again'),before=dump(again);
 assert.notEqual(run(again,M49).status,0,'a second apply is refused');
 assert.deepEqual(dump(again),before,'and changes nothing');
 fails(copyOf(db,'down'),'UPDATE schema_contract SET version=48 WHERE id=1');
}
for(const table of ['film_metadata_field','film_metadata_history','film_metadata_owner_command','film_metadata_owner_release'])assert.equal(rows(db,'SELECT COUNT(*) AS n FROM '+table)[0].n,0,table+' is created empty');
assert.deepEqual(rows(db,'SELECT id,mode,revision FROM film_metadata_provenance_control'),[{id:1,mode:'off',revision:1}],'the control row is inserted at off');
assert.equal(rows(db,"SELECT strict FROM pragma_table_list WHERE name='film_metadata_field'")[0].strict,1,'STRICT');
assert.equal(rows(db,"SELECT wr FROM pragma_table_list WHERE name='film_metadata_field'")[0].wr,1,'WITHOUT ROWID');
assert.deepEqual(rows(db,"SELECT name FROM pragma_index_list('film_metadata_field')").map(row=>row.name),['sqlite_autoindex_film_metadata_field_1'],'the primary key is the only index');
assert.equal(rows(db,"SELECT COUNT(*) AS n FROM pragma_foreign_key_list('film_metadata_field')")[0].n,0,'no foreign key');
// an existing row is untouched
assert.equal(rows(db,"SELECT COUNT(*) AS n FROM film_metadata").length,1);

// ---- 2. the DDL constraints ----
{
 const file=copyOf(db,'ddl');
 exec(file,FILM('film:a')+META('film:a'));
 exec(file,FIELD('film:a','year'));
 for(const [why,over] of [
  ['an unknown field',{field:'title'}],['an unknown tier',{tier:'pinned'}],['an unknown source',{source:'epg'}],['an unknown origin',{origin:'epg'}],['an unknown scheme',{anchor_scheme:'imdb'}],
  ['an anchor scheme without a value',{anchor_value:null}],['a short digest',{anchor_digest:'abc'}],['an upper-case digest',{anchor_digest:'A'.repeat(64)}],['a value digest of non-hex',{value_digest:'g'.repeat(64)}],
  ['an automatic row without agreement',{agreement:null}],['an owner row with an agreement',{tier:'owner',agreement:'confirmed'}],['an automatic row without an anchor',{anchor_scheme:null,anchor_value:null}],['an automatic row without an anchor digest',{anchor_digest:null}],
  ['an owner source with an anchor scheme',{tier:'owner',source:'owner',origin:'owner_route',agreement:null}],['an owner source without an anchor digest',{tier:'owner',source:'owner',origin:'owner_route',agreement:null,anchor_scheme:null,anchor_value:null,anchor_digest:null}],
  ['an owner source from the producer origin',{tier:'owner',source:'owner',origin:'catalog_enrichment',agreement:null,anchor_scheme:null,anchor_value:null}],['an unattributed automatic row',{source:'unattributed',origin:'owner_route'}],
  ['a written revision of 0',{written_revision:0}],['a short observation instant',{observed_at:'2026-11-27'}],['a negative-length write key',{write_key:''}],
 ])fails(file,FIELD('film:a','runtime',over),/CHECK|constraint/i);
 // ADR 0224: the language of a value and its evidence basis are typed columns of the same row
 for(const [why,over,name] of [['a language without a basis',{language:'ru'},'synopsis'],['a basis without a language',{language_basis:'explicit'},'synopsis'],['an unsupported language',{language:'de',language_basis:'explicit'},'synopsis'],['an unsupported basis',{language:'ru',language_basis:'verified'},'synopsis'],['a language on a field that has none',{language:'ru',language_basis:'explicit'},'year2'],['assumed on a TMDB synopsis',{source:'tmdb',anchor_scheme:'tmdb',language:'en',language_basis:'assumed'},'synopsis'],['assumed on a poster',{language:'en',language_basis:'assumed'},'poster'],['assumed Russian',{language:'ru',language_basis:'assumed'},'synopsis']])
  fails(file,FIELD('film:b',name==='year2'?'runtime':name,over),/CHECK|constraint/i);
 exec(file,FIELD('film:b','synopsis',{language:'en',language_basis:'assumed'}));
 exec(file,FIELD('film:b','poster',{source:'tmdb',anchor_scheme:'tmdb',language:'ru',language_basis:'explicit'}));
 fails(file,"UPDATE film_metadata_field SET language='de' WHERE film_id='film:b' AND field='synopsis'",/CHECK|constraint/i);
 fails(file,`INSERT INTO film_metadata_history (film_id,field,reason,write_key,at,old_language) VALUES ('film:a','year','replaced','wl1','${T}','de')`,/CHECK/i);
 // an assumed English without its Letterboxd source is refused on both sides (a NULL source must not satisfy the predicate)
 for(const [why,cols,vals] of [['assumed English with no old source','old_language,old_language_basis',"'en','assumed'"],['assumed English with no new source','new_language,new_language_basis',"'en','assumed'"],['assumed English with a NULL old source and a new source','old_language,old_language_basis,new_language,new_language_basis,new_source',"'en','assumed','en','explicit','tmdb'"]])
  fails(file,`INSERT INTO film_metadata_history (film_id,field,reason,write_key,at,${cols}) VALUES ('film:a','synopsis','replaced','n-${why.length}','${T}',${vals})`,/CHECK/i);
 for(const [why,cols,vals] of [['assumed Russian on the old side','old_language,old_language_basis,old_source',"'ru','assumed','letterboxd'"],['assumed Russian on the new side','new_language,new_language_basis,new_source',"'ru','assumed','letterboxd'"],['unpaired new language','new_language',"'ru'"]])
  fails(file,`INSERT INTO film_metadata_history (film_id,field,reason,write_key,at,${cols}) VALUES ('film:a','synopsis','replaced','x-${why.length}','${T}',${vals})`,/CHECK/i);
 exec(file,`INSERT INTO film_metadata_history (film_id,field,reason,write_key,at,old_language,old_language_basis,old_source,new_language,new_language_basis,new_source) VALUES ('film:a','synopsis','replaced','wl2','${T}','en','assumed','letterboxd','ru','explicit','tmdb')`);
 exec(file,FIELD('film:a','runtime',{tier:'owner',source:'owner',origin:'owner_route',agreement:null,anchor_scheme:null,anchor_value:null}));
 exec(file,FIELD('film:a','synopsis',{tier:'owner',source:'unattributed',origin:'owner_route',agreement:null,anchor_scheme:null,anchor_value:null,anchor_digest:null}));
 exec(file,FIELD('film:a','poster',{tier:'released',source:'unattributed',origin:'owner_route',agreement:null,anchor_scheme:null,anchor_value:null,anchor_digest:null}));
 exec(file,FIELD('film:a','url',{tier:'owner',agreement:null}));
 fails(file,FIELD('film:a','year'),/UNIQUE|PRIMARY/);
 // history: reasons, the merge column, uniqueness
 const HIST=(over='')=>`INSERT INTO film_metadata_history (film_id,field,reason,write_key,at${over?','+over.split('|')[0]:''}) VALUES ('film:a','year','replaced','w1','${T}'${over?','+over.split('|')[1]:''})`;
 exec(file,HIST());
 fails(file,HIST(),/UNIQUE/);
 fails(file,`INSERT INTO film_metadata_history (film_id,field,reason,write_key,at) VALUES ('film:a','year','vanished','w2','${T}')`,/CHECK/i);
 fails(file,`INSERT INTO film_metadata_history (film_id,field,reason,write_key,at) VALUES ('film:a','year','merge_discarded','w3','${T}')`,/CHECK/i);
 exec(file,`INSERT INTO film_metadata_history (film_id,field,reason,write_key,at,merged_from) VALUES ('film:a','year','merge_discarded','w3','${T}','film:b')`);
 fails(file,`INSERT INTO film_metadata_history (film_id,field,reason,write_key,at,old_anchor_digest) VALUES ('film:a','year','replaced','w4','${T}','zz')`,/CHECK/i);
 // the command record: refresh alone may have no applied revision
 const CMD=(id,action,revision)=>`INSERT INTO film_metadata_owner_command (request_id,film_id,action,command_digest,outcome,applied_revision,at) VALUES ('${id}','film:a','${action}','${H}','applied',${revision},'${T}')`;
 exec(file,CMD('c1','set',2));exec(file,CMD('c2','refresh','NULL'));
 fails(file,CMD('c3','set','NULL'),/CHECK/i);fails(file,CMD('c4','teleport',2),/CHECK/i);fails(file,CMD('c1','lock',3),/UNIQUE|PRIMARY/);
}

// ---- 3. invalidation, locks and immutability on raw statements ----
{
 const file=copyOf(db,'raw');
 exec(file,FILM('film:a')+META('film:a')+FIELD('film:a','year')+';'+FIELD('film:a','runtime'));
 // invalidation is always on, even at off; only the changed column's row goes
 exec(file,"UPDATE film_metadata SET year=2000 WHERE film_id='film:a'");
 assert.deepEqual(rows(file,'SELECT field FROM film_metadata_field').map(row=>row.field),['runtime']);
 exec(file,"UPDATE film_metadata SET runtime=136,updated_at='"+T+"' WHERE film_id='film:a'");
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM film_metadata_field')[0].n,1,'an equal value deletes nothing');
 exec(file,"DELETE FROM film_metadata WHERE film_id='film:a'");
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM film_metadata_field')[0].n,0);
 exec(file,META('film:a')+';'+FIELD('film:a','year'));
 exec(file,"INSERT INTO film_metadata_provenance_control (id,mode,revision,updated_at,updated_by) VALUES (1,'off',1,'"+T+"','x') ON CONFLICT(id) DO NOTHING");
 // an owner pin is inert at off (no lock trigger fires), protected by its own trigger from the first moment
 exec(file,FIELD('film:a','runtime',{tier:'owner',agreement:null}));
 exec(file,"UPDATE film_metadata SET runtime=140 WHERE film_id='film:a'");
 assert.equal(rows(file,"SELECT tier FROM film_metadata_field WHERE field='runtime'")[0].tier,'owner','invalidation never deletes a pin');
 fails(file,"UPDATE film_metadata_field SET tier='released' WHERE field='runtime'",/film_metadata_owner_locked/);
 fails(file,"DELETE FROM film_metadata_field WHERE field='runtime'",/film_metadata_owner_locked/);
 exec(file,"UPDATE film_metadata_provenance_control SET mode='enforce',revision=2,updated_at='"+T+"',updated_by='t'");
 fails(file,"UPDATE film_metadata SET runtime=141 WHERE film_id='film:a'",/film_metadata_owner_locked/);
 exec(file,"UPDATE film_metadata SET year=1999 WHERE film_id='film:a'");
 exec(file,"UPDATE film_metadata SET synopsis='other',poster='/q' WHERE film_id='film:a'");
 fails(file,"DELETE FROM film_metadata WHERE film_id='film:a'",/film_metadata_owner_locked/);
 fails(file,"PRAGMA foreign_keys=OFF;UPDATE film_metadata SET film_id='film:z' WHERE film_id='film:a'",/film_metadata_owner_locked/);
 // the release row opens the lock for its Film only, inside the same batch
 fails(file,"BEGIN;INSERT INTO film_metadata_owner_release (film_id) VALUES ('film:other');UPDATE film_metadata SET runtime=141 WHERE film_id='film:a';COMMIT;",/film_metadata_owner_locked/);
 exec(file,"BEGIN;INSERT INTO film_metadata_owner_release (film_id) VALUES ('film:a');UPDATE film_metadata SET runtime=141 WHERE film_id='film:a';DELETE FROM film_metadata_owner_release WHERE film_id='film:a';COMMIT;");
 assert.equal(rows(file,'SELECT runtime FROM film_metadata')[0].runtime,141);
}
// the metadata dimension lock protects every field (the legal transition comes first)
{
 const file=copyOf(db,'dim2');
 exec(file,FILM('film:a')+META('film:a')+"UPDATE film_metadata_provenance_control SET mode='enforce',revision=2,updated_at='"+T+"',updated_by='t';");
 exec(file,`INSERT INTO film_dimension (film_id,dimension,status,source,provenance_json,authority,attempts,next_action,updated_at) VALUES ('film:a','metadata','reviewed','owner','{}','owner',0,'none','${T}')`);
 fails(file,"UPDATE film_metadata SET year=1800 WHERE film_id='film:a'",/film_metadata_owner_locked/);
 exec(file,"UPDATE film_metadata SET people_version=4 WHERE film_id='film:a'");
 fails(file,"DELETE FROM film_metadata WHERE film_id='film:a'",/film_metadata_owner_locked/);
 exec(file,"UPDATE film_dimension SET status='fresh',authority=NULL WHERE film_id='film:a' AND dimension='metadata'");
 exec(file,"UPDATE film_metadata SET year=1800 WHERE film_id='film:a'");
}

// ---- 4. the control row ----
{
 const file=copyOf(db,'control');
 const set=(mode,revision)=>`UPDATE film_metadata_provenance_control SET mode='${mode}',revision=${revision},updated_at='${T}',updated_by='t' WHERE id=1`;
 fails(file,set('hold',2),/film_metadata_provenance_transition/);
 fails(file,set('enforce',3),/film_metadata_provenance_transition/);
 fails(file,set('enforce',1),/film_metadata_provenance_transition/);
 exec(file,set('enforce',2));
 fails(file,set('off',3),/film_metadata_provenance/);
 exec(file,set('hold',3));fails(file,set('off',4),/film_metadata_provenance/);
 exec(file,set('enforce',4));
 fails(file,"UPDATE film_metadata_provenance_control SET updated_by='x'",/film_metadata_provenance_transition/);
 fails(file,'DELETE FROM film_metadata_provenance_control',/film_metadata_provenance_no_delete/);
 fails(file,"UPDATE film_metadata_provenance_control SET mode='paused',revision=5,updated_at='"+T+"',updated_by='t'",/CHECK|film_metadata_provenance_transition/i);
 fails(file,"INSERT INTO film_metadata_provenance_control (id,mode,revision,updated_at,updated_by) VALUES (2,'off',1,'"+T+"','x')",/CHECK/i);
 assert.deepEqual(rows(file,'SELECT mode,revision FROM film_metadata_provenance_control'),[{mode:'enforce',revision:4}]);
}

// ---- 5. the protection signal: only a pin that becomes unprotected, and only in the inbox ----
{
 const file=copyOf(db,'signal');
 exec(file,FILM('film:a')+META('film:a')+FIELD('film:a','year',{tier:'owner',agreement:null})+';'+FIELD('film:a','runtime')+";UPDATE film_metadata_provenance_control SET mode='enforce',revision=2,updated_at='"+T+"',updated_by='t';");
 const keys=()=>rows(file,"SELECT kind,subject,part,version FROM enrichment_signal ORDER BY kind,subject,part");
 exec(file,"UPDATE film_metadata_field SET checked_at='"+T+"' WHERE field='runtime'");
 assert.deepEqual(keys(),[],'an automatic row changing emits nothing');
 exec(file,"INSERT INTO film_metadata_owner_release (film_id) VALUES ('film:a');UPDATE film_metadata_field SET tier='released',agreement=NULL WHERE field='year';");
 assert.deepEqual(keys(),[{kind:'protection_released',subject:'film:a',part:'core',version:1}],'a released pin wakes the core part');
 exec(file,"DELETE FROM film_metadata_owner_release");
 assert.deepEqual(keys(),[{kind:'protection_released',subject:'film:a',part:'core',version:1}],'the release row itself signals nothing');
 exec(file,"INSERT INTO film_metadata_owner_release (film_id) VALUES ('film:a');UPDATE film_metadata_field SET tier='owner',agreement=NULL WHERE field='runtime';UPDATE film_metadata_field SET tier='released' WHERE field='runtime';DELETE FROM film_metadata_owner_release;");
 assert.deepEqual(keys().map(item=>item.version),[2],'a second release re-arms the same coalesced row');
}
console.log('migration 0049: ok');
