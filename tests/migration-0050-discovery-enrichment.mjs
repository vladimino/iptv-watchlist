// AIR-684: migration 0050, the Discovery scope of the Catalog Enrichment Producer (ADR 0219 decision 3), on scratch sqlite databases built from the real migrations. Offline; synthetic ids only.
//  - the chain 49 -> 50 and the refusals (wrong predecessor, a second apply); additive: no existing row changes;
//  - nothing is emitted before the scope is first activated on the steady path; a movie insert after it writes one `pending` admitted signal, a TV row never does, a repeat is one row with a raised version;
//  - a movie insert while a transfer is loading is `staged` whether or not the scope is activated (never consumable), a TV row is never staged;
//  - the commit of a RESOLVER transfer with the scope activated promotes the staged signals whose row is current and deletes the rest; before activation it deletes them (history);
//  - an import or restore (no origin) has its staged signals deleted, a later unrelated transfer never promotes them, an abandoned resolver attempt is kept and promoted only by a later resolver publication;
//  - a stale origin (an old-version statement that did not stamp it) is dropped at the next loading start and never promotes; a historical row updated by a transfer emits nothing; a retry upserts without a second signal.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {migrated} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const M50=fs.readFileSync('migrations/0050_discovery_enrichment_scope.sql','utf8');
const run=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<28});
const exec=(file,text)=>{const r=run(file,text);if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);const o=String(r.stdout).trim();return o?JSON.parse(o):[];};
const version=file=>Number(rows(file,'SELECT version FROM schema_contract WHERE id=1')[0].version);
const dump=file=>{const r=sqliteSync([file,'.dump'],{encoding:'utf8',maxBuffer:1<<30});if(r.status!==0)throw new Error(r.stderr);return String(r.stdout).split('\n');};
const T='2026-11-27T10:00:00.000Z';
const sig=file=>rows(file,"SELECT subject,state,version,cause_ref FROM enrichment_signal WHERE source='discovery' ORDER BY subject");
const states=file=>sig(file).map(s=>s.subject+'='+s.state+'@v'+s.version);
const ADM=(id,kind='movie',state='current')=>`INSERT INTO discovery_admission (film_id,tmdb_id,media_kind,canonical_identity,generation,state,payload_json) VALUES ('${kind==='tv'?'tv_':'tmdb_'}${id}','${id}','${kind}','tmdb:${id}',1,'${state}','{}')`;
const ACTIVATE=`INSERT INTO catalog_enrichment_scope (scope,activated,enabled,cutoff_at,revision,updated_at) VALUES ('discovery',1,1,'${T}',1,'${T}')`;
// a transfer as replaceCatalog drives it: the loading statement (stamped when the writer is the new version), rows, the commit
const LOADING=(origin,run,batches)=>origin?`UPDATE discovery_transfer SET state='loading', programme_run_id='${run}', origin='${origin}', origin_batches=${batches}, batches=${batches} WHERE id=1`:`UPDATE discovery_transfer SET state='loading', batches=${batches} WHERE id=1`;
const COMMIT=`UPDATE discovery_admission SET state='superseded' WHERE state='pending'; UPDATE discovery_transfer SET state='committed', batches=batches+1 WHERE id=1`;
const fresh=()=>{const f=migrated(49);exec(f,'UPDATE discovery_authority SET mode=\'d1\', cutover=\'open\' WHERE id=1');return f;};
const apply=f=>exec(f,M50);

// ---- 1. the chain, the refusals, additive ----
{
 const f=fresh();assert.equal(version(f),49);
 const before=rows(f,'SELECT * FROM discovery_transfer');
 apply(f);assert.equal(version(f),50);
 assert.deepEqual(rows(f,'SELECT id,state,programme_run_id,batches FROM discovery_transfer'),before.map(r=>({id:r.id,state:r.state,programme_run_id:r.programme_run_id,batches:r.batches})),'the transfer row is unchanged');
 assert.deepEqual(rows(f,'SELECT origin,origin_batches FROM discovery_transfer'),[{origin:null,origin_batches:null}]);
 assert.notEqual(run(f,M50).status,0,'a second apply is refused');
 assert.equal(version(f),50);
 const v46=migrated(48),b=dump(v46);assert.notEqual(run(v46,M50).status,0,'on version 48 the file aborts');assert.deepEqual(dump(v46),b,'and nothing changed');
 assert.notEqual(run(f,"UPDATE discovery_transfer SET origin='import' WHERE id=1").status,0,'only `resolver` is a stored origin');
 assert.equal(version(migrated()),54,'the full chain ends at 54 (0054, AIR-625, after 0053, AIR-693)');
}

// ---- 2. the steady path: nothing before the activation, one signal after, TV never ----
{
 const f=fresh();apply(f);
 exec(f,ADM(1));assert.deepEqual(sig(f),[],'before the first activation the steady path writes nothing');
 exec(f,ACTIVATE);
 exec(f,ADM(2));exec(f,ADM(3,'tv'));
 assert.deepEqual(states(f),['tmdb:2=pending@v1'],'a movie writes one pending admitted signal; a TV row never');
 assert.equal(sig(f)[0].cause_ref,'discovery_admission');
 assert.deepEqual(rows(f,"SELECT kind,source,part,acked_version FROM enrichment_signal"),[{kind:'admitted',source:'discovery',part:'',acked_version:0}]);
 // a disabled scope keeps recording (the gate is `activated`, never `enabled`)
 exec(f,"UPDATE catalog_enrichment_scope SET enabled=0, revision=2 WHERE scope='discovery'");
 exec(f,ADM(4));assert.deepEqual(states(f),['tmdb:2=pending@v1','tmdb:4=pending@v1'],'a disabled scope still records');
 // a historical row updated later emits nothing (no update trigger) and an upsert of an existing film id is not an insert
 exec(f,"UPDATE discovery_admission SET payload_json='{\"a\":1}' WHERE film_id='tmdb_1'");
 exec(f,"INSERT INTO discovery_admission (film_id,tmdb_id,media_kind,canonical_identity,generation,state,payload_json) VALUES ('tmdb_2','2','movie','tmdb:2',2,'current','{}') ON CONFLICT(film_id) DO UPDATE SET generation=excluded.generation");
 assert.deepEqual(states(f),['tmdb:2=pending@v1','tmdb:4=pending@v1'],'a history row updated, or an existing Film upserted, emits nothing and creates no second signal');
 // a re-admission of an identity whose signal exists re-arms it (a consumed signal becomes pending at a new version)
 exec(f,"UPDATE enrichment_signal SET acked_version=1, state='consumed' WHERE subject='tmdb:2'");
 exec(f,"DELETE FROM discovery_admission WHERE film_id='tmdb_2'");exec(f,ADM(2));
 assert.deepEqual(rows(f,"SELECT state,version,acked_version FROM enrichment_signal WHERE subject='tmdb:2'"),[{state:'pending',version:2,acked_version:1}]);
}

// ---- 3. staging inside a transfer and the settlement at the commit ----
{
 // 3a. a resolver publication after the activation: current rows become pending, a TV row collision is never staged, a superseded row is deleted
 const f=fresh();apply(f);exec(f,ACTIVATE);
 exec(f,"UPDATE discovery_admission SET state='pending' WHERE state='current'");
 exec(f,LOADING('resolver','run-A',1));
 exec(f,ADM(10));exec(f,ADM(11));exec(f,ADM(10,'tv'));
 assert.deepEqual(states(f),['tmdb:10=staged@v1','tmdb:11=staged@v1'],'inside a loading transfer a movie is staged, a TV row with the same id is not');
 assert.equal(sig(f)[0].cause_ref,'resolver:run-A','the staged signal carries the origin and the transfer identity');
 exec(f,"UPDATE discovery_admission SET state='pending' WHERE film_id='tmdb_11' AND media_kind='movie'");// the row stops being current before the commit
 exec(f,COMMIT);
 assert.deepEqual(states(f),['tmdb:10=pending@v2'],'the commit promotes the staged signal of the current row and deletes the other');
 assert.deepEqual(rows(f,'SELECT origin,origin_batches,state FROM discovery_transfer'),[{origin:null,origin_batches:null,state:'committed'}],'the origin never survives the commit');
 // 3b. a later steady upsert of the same Film creates no second signal
 exec(f,"INSERT INTO discovery_admission (film_id,tmdb_id,media_kind,canonical_identity,generation,state,payload_json) VALUES ('tmdb_10','10','movie','tmdb:10',3,'current','{}') ON CONFLICT(film_id) DO UPDATE SET generation=excluded.generation");
 assert.deepEqual(states(f),['tmdb:10=pending@v2']);
}
{
 // 3c. a resolver publication BEFORE the activation: the staged rows are history and are deleted; a later one is stream
 const f=fresh();apply(f);
 exec(f,LOADING('resolver','run-A',1));exec(f,ADM(20));
 assert.deepEqual(states(f),['tmdb:20=staged@v1'],'staged whether or not the scope has been activated');
 exec(f,COMMIT);assert.deepEqual(sig(f),[],'published before the activation: history, no signal');
 exec(f,ACTIVATE);
 exec(f,LOADING('resolver','run-B',3));exec(f,ADM(21));exec(f,COMMIT);
 assert.deepEqual(states(f),['tmdb:21=pending@v2'],'published after the activation: stream');
 // a row staged before the activation but published after it is stream
 const g=fresh();apply(g);
 exec(g,LOADING('resolver','run-A',1));exec(g,ADM(30));
 exec(g,ACTIVATE);exec(g,COMMIT);
 assert.deepEqual(states(g),['tmdb:30=pending@v2'],'staged before the activation, published after it: stream');
}
{
 // 3d. a failed/partial transfer leaves its staged signals inert; its retry (upserts, no second insert) settles them by identity
 const f=fresh();apply(f);exec(f,ACTIVATE);
 exec(f,LOADING('resolver','run-A',1));exec(f,ADM(40));
 assert.deepEqual(states(f),['tmdb:40=staged@v1'],'a partial transfer: inert');
 assert.equal(rows(f,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE state='pending'")[0].n,0,'never consumable');
 exec(f,LOADING('resolver','run-A',2));// the retry of the same programme run: the row exists, so it is an upsert
 exec(f,"INSERT INTO discovery_admission (film_id,tmdb_id,media_kind,canonical_identity,generation,state,payload_json) VALUES ('tmdb_40','40','movie','tmdb:40',2,'current','{}') ON CONFLICT(film_id) DO UPDATE SET generation=excluded.generation");
 assert.deepEqual(states(f),['tmdb:40=staged@v1'],'the retry keeps the one staged signal');
 exec(f,COMMIT);assert.deepEqual(states(f),['tmdb:40=pending@v2'],'and its commit settles it once');
}
{
 // 3e. an import or restore (no origin): staged signals are deleted at its commit, and a later unrelated transfer never promotes them
 const f=fresh();apply(f);exec(f,ACTIVATE);
 exec(f,LOADING(null,null,1));exec(f,ADM(50));
 assert.deepEqual(rows(f,"SELECT cause_ref FROM enrichment_signal"),[{cause_ref:'other:'}],'a non-authoritative origin is recorded as `other`');
 exec(f,COMMIT);assert.deepEqual(sig(f),[],'a non-authoritative commit deletes its staged signals');
 // an interrupted import: staged remain inert, then the next non-authoritative start deletes them and a resolver commit never promotes them
 const g=fresh();apply(g);exec(g,ACTIVATE);
 exec(g,LOADING(null,null,1));exec(g,ADM(51));
 assert.deepEqual(states(g),['tmdb:51=staged@v1']);
 exec(g,LOADING('resolver','run-B',2));
 assert.deepEqual(sig(g),[],'the next loading start deletes the staged signals of a non-resolver origin');
 exec(g,COMMIT);assert.deepEqual(sig(g),[],'a later unrelated transfer never promotes them');
}
{
 // 3f. an abandoned resolver attempt is kept through a non-resolver transfer and promoted only by a later resolver publication that makes the row current
 const f=fresh();apply(f);exec(f,ACTIVATE);
 exec(f,LOADING('resolver','run-A',1));exec(f,ADM(60));exec(f,ADM(61));
 exec(f,LOADING(null,null,2));
 assert.deepEqual(states(f),['tmdb:60=staged@v1','tmdb:61=staged@v1'],'the abandoned resolver attempt keeps its facts through another start');
 exec(f,COMMIT);assert.deepEqual(states(f),['tmdb:60=staged@v1','tmdb:61=staged@v1'],'and through a non-resolver commit');
 exec(f,LOADING('resolver','run-C',5));
 exec(f,"UPDATE discovery_admission SET state='superseded' WHERE film_id='tmdb_61'");
 exec(f,"UPDATE discovery_admission SET state='pending' WHERE film_id='tmdb_60'");
 exec(f,"INSERT INTO discovery_admission (film_id,tmdb_id,media_kind,canonical_identity,generation,state,payload_json) VALUES ('tmdb_60','60','movie','tmdb:60',2,'current','{}') ON CONFLICT(film_id) DO UPDATE SET state='current', generation=excluded.generation");
 exec(f,COMMIT);
 assert.deepEqual(states(f),['tmdb:60=pending@v2'],'promoted by the later resolver publication that makes its row current; the one that is not current is deleted');
}
{
 // 3g. a stale origin: an old-version loading statement does not stamp, so the origin of an abandoned transfer is dropped and can never promote
 const f=fresh();apply(f);exec(f,ACTIVATE);
 exec(f,LOADING('resolver','run-A',1));exec(f,ADM(70));
 exec(f,LOADING(null,null,2));// the old-version statement
 assert.deepEqual(rows(f,'SELECT origin,origin_batches FROM discovery_transfer'),[{origin:null,origin_batches:null}],'the stale origin is dropped');
 exec(f,ADM(71));assert.deepEqual(rows(f,"SELECT subject,cause_ref FROM enrichment_signal ORDER BY subject"),[{subject:'tmdb:70',cause_ref:'resolver:run-A'},{subject:'tmdb:71',cause_ref:'other:run-A'}]);
 exec(f,COMMIT);
 assert.deepEqual(states(f),['tmdb:70=staged@v1'],'the old-version commit deletes its own staged signal and promotes nothing');
}
{
 // 3h. a re-admission of an identity whose signal was consumed is promoted at a new version (never missed); the signal already pending is left alone by staging
 const f=fresh();apply(f);exec(f,ACTIVATE);
 exec(f,"INSERT INTO enrichment_signal (kind,subject,source,part,version,acked_version,state,armed_at,attempts) VALUES ('admitted','tmdb:80','discovery','',1,1,'consumed','"+T+"',0)");
 exec(f,LOADING('resolver','run-A',1));exec(f,ADM(80));
 assert.deepEqual(states(f),['tmdb:80=consumed@v1'],'staging never overwrites a signal that is already consumed or pending');
}
console.log('migration 0050 discovery enrichment scope ok');
