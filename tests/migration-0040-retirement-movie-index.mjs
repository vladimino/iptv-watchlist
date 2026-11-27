// AIR-667: migration 0040 (one additive lookup index tmdb_retirement_decision_movie on tmdb_retirement_decision(movie_id)). Offline only: scratch sqlite
// databases built from the real chain; nothing is applied anywhere.
//  - the chain 38 -> 39 -> 40, and the refusals (wrong predecessor, inconsistent 39, a second apply, a same-named object);
//  - 0040 changes no data: a full dump of a populated synthetic ledger before and after differs only by the index and the schema_contract row;
//  - the real IDENTITY_SNAPSHOT_SQL (requested and claimed movie ids, hits and misses): before, the ledger is scanned; after, it is SEARCHed by the new index;
//    the snapshot returns the same row;
//  - retirement and restore parity of the legacy readers by movie id (canonical-catalog-reader, canonical-letterboxd-claim) and by film id;
//  - the append-only triggers of 0016 still refuse update and delete.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {migrated} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {IDENTITY_SNAPSHOT_SQL} from '../src/film-aggregate-resolver.js';

const M40=fs.readFileSync('migrations/0040_tmdb_retirement_decision_movie_index.sql','utf8');
const INDEX='tmdb_retirement_decision_movie';
const run=(file,text)=>sqliteSync(['-bail',file],{input:text,encoding:'utf8',maxBuffer:1<<28});
const exec=(file,text)=>{const result=run(file,text);if(result.status!==0)throw new Error(result.stderr);return String(result.stdout);};
const rows=(file,text)=>{const result=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr);const out=String(result.stdout).trim();return out?JSON.parse(out):[];};
const version=file=>Number(rows(file,'SELECT version FROM schema_contract WHERE id=1')[0].version);
const objects=file=>rows(file,"SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").map(item=>item.type+':'+item.name);
let copies=0;
const copyOf=(file,name)=>{const target=file.replace(/\.sqlite$/,'-'+name+'-'+(copies++)+'.sqlite');fs.copyFileSync(file,target);return target;};
const dump=file=>{const result=sqliteSync([file,'.dump'],{encoding:'utf8',maxBuffer:1<<30});if(result.status!==0)throw new Error(result.stderr);return String(result.stdout).split('\n');};
const plan=(file,text)=>{const out=run(file,'EXPLAIN QUERY PLAN '+text+';');assert.equal(out.status,0,out.stderr);return String(out.stdout).split('\n').map(line=>line.replace(/^[\s|`-]+/,'').trim()).filter(Boolean);};
const q=value=>"'"+String(value).replace(/'/g,"''")+"'";

// ---- 1. the chain and the refusals ---------------------------------------------------------------------------------------------------------------------
const v38=migrated(38);
assert.equal(version(v38),38);
const refuse=(file,reason)=>{
 const before=objects(file),ver=version(file),result=run(file,M40);
 assert.notEqual(result.status,0,reason+': the file aborts');
 assert.deepEqual(objects(file),before,reason+': no object created');assert.equal(version(file),ver,reason+': the version is unchanged');
};
refuse(copyOf(v38,'on38'),'on version 38');
const v39=migrated(39);
assert.equal(version(v39),39);
assert.ok(!objects(v39).includes('index:'+INDEX),'version 39 has no movie index');
{
 const missingIndex=copyOf(v39,'bad-index');exec(missingIndex,'DROP INDEX tmdb_retirement_decision_tv;');refuse(missingIndex,'a missing 0016 index');
 const missing39=copyOf(v39,'bad-39');exec(missing39,'DROP INDEX canonical_write_receipt_operation_history;');refuse(missing39,'an incomplete version 39');
 const early=copyOf(v39,'early');exec(early,'CREATE INDEX '+INDEX+' ON tmdb_retirement_decision (movie_id);');refuse(early,'a pre-existing index of the same name');
 for(const [name,statement] of [
  ['an absent schema_contract row','DELETE FROM schema_contract;'],
  ['a missing v39 unresolved index','DROP INDEX canonical_write_receipt_operation_unresolved;'],
  ['a missing v39 immutable-key trigger','DROP TRIGGER canonical_write_receipt_operation_key_immutable;'],
  ['a missing no-downgrade trigger','DROP TRIGGER schema_contract_no_downgrade;'],
  ['a missing ledger no-delete trigger','DROP TRIGGER tmdb_retirement_decision_no_delete;'],
 ]){
  const file=copyOf(v39,'bad');exec(file,statement);
  const before=dump(file),result=run(file,M40);
  assert.notEqual(result.status,0,name+': the file aborts');
  assert.deepEqual(dump(file),before,name+': the whole state is unchanged');
  assert.ok(!objects(file).includes('index:'+INDEX),name+': no index installed');
 }
 const other=copyOf(v39,'other');exec(other,'CREATE INDEX '+INDEX+' ON tmdb_retirement_decision (tv_id);');refuse(other,'a same-named index of another shape');
}

// ---- 2. a populated synthetic ledger, then the real migration ------------------------------------------------------------------------------------------
// 3000 retire decisions over 2000 movie ids, every fifth restored; a few movie ids retired twice under different Films. Synthetic values only.
const CONFIRM=q(JSON.stringify({by:'owner',at:'2026-11-25T00:00:00Z',source:'synthetic'}));
exec(v39,`PRAGMA foreign_keys=ON;
 WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<3000)
 INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,payload_json,recorded_at)
 SELECT 'ret-'||i,'film:syn:'||i,'retire','l'||i,CAST(1+(i%2000) AS TEXT),CAST(500000+i AS TEXT),'{}',${CONFIRM},'owner_request','{}','2026-11-25T00:00:00Z' FROM n;
 INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,supersedes_seq,payload_json,recorded_at)
 SELECT 'res-'||seq,film_id,'restore',lid,movie_id,tv_id,'{}',${CONFIRM},'owner_request',seq,'{}','2026-11-25T01:00:00Z' FROM tmdb_retirement_decision WHERE seq%5=0;`);
const LEDGER=Number(rows(v39,'SELECT COUNT(*) AS n FROM tmdb_retirement_decision')[0].n);
assert.equal(LEDGER,3600);

const before=copyOf(v39,'before'),after=copyOf(v39,'after');
const dumpBefore=dump(before);
exec(after,M40);
assert.equal(version(after),40);
assert.deepEqual(objects(after),[...objects(before),'index:'+INDEX].sort(),'exactly the one index is new');
refuse(copyOf(after,'again'),'a second apply on version 40');
assert.equal(version(migrated(40)),40,'the chain through 0040 ends at version 40');
assert.ok(objects(migrated(40)).includes('index:'+INDEX),'the chain through 0040 carries the index');
assert.ok(objects(migrated(40)).every(name=>objects(migrated()).includes(name)),'a later migration (0041, AIR-601) keeps every 0040 object');
assert.equal(version(migrated(42)),42,'the chain through 0042 ends at version 42 (0042 follows 0041, which follows 0040)');
assert.equal(version(migrated()),48,'the full chain ends at version 48 (0048, AIR-672, follows 0047, AIR-605, which follows 0046, AIR-602)');

const shape=rows(after,"SELECT name,\"unique\" AS uniq,partial FROM pragma_index_list('tmdb_retirement_decision')").find(item=>item.name===INDEX);
assert.equal(shape.uniq,0,'non-unique');assert.equal(shape.partial,0,'not partial');
assert.deepEqual(rows(after,"SELECT name FROM pragma_index_info('"+INDEX+"') ORDER BY seqno").map(item=>item.name),['movie_id']);

const dumpAfter=dump(after);
const strip=lines=>lines.filter(line=>!line.startsWith('INSERT INTO schema_contract')&&!line.includes(INDEX));
assert.deepEqual(strip(dumpAfter),strip(dumpBefore),'every ledger row, trigger, marker and authority row is unchanged');
assert.equal(dumpAfter.filter(line=>line.startsWith('INSERT INTO schema_contract')).length,1,'still one schema_contract row');
assert.match(dumpAfter.find(line=>line.startsWith('INSERT INTO schema_contract')),/\b40\b/);

// ---- 3. the actual resolver snapshot -------------------------------------------------------------------------------------------------------------------
// Requested movie ids and claimed movie ids enter the same `movie_id IN (json_each(?))` list; hits (retired, restored, retired twice) and misses.
const bind=(films,pairs,movies)=>{
 const params=[films,films,films,films,'65',pairs,'65',movies,'65'];let i=0;
 const text=IDENTITY_SNAPSHOT_SQL.replace(/\?/g,()=>{const v=params[i++];return /^\d+$/.test(v)?v:q(v);});
 assert.equal(i,params.length,'every parameter is bound');return text;
};
const cases={
 requested:bind('["film:syn:7"]','[["tmdb","8"]]','["8"]'),
 claimed:bind('["film:syn:7","film:syn:10"]','[["tmdb","8"],["letterboxd","l7"]]','["8","11","2001"]'),
 restored:bind('["film:syn:5"]','[["tmdb","6"]]','["6"]'),
 retiredTwice:bind('["film:syn:1","film:syn:2001"]','[]','["2"]'),
 miss:bind('["film:none"]','[["tmdb","999999"]]','["999999"]'),
 empty:bind('[]','[]','[]'),
};
const ledgerScan=lines=>lines.filter(d=>/^SCAN tmdb_retirement_decision\b/.test(d));
for(const [name,text] of Object.entries(cases)){
 const b=plan(before,text),a=plan(after,text);
 assert.ok(ledgerScan(b).length>0,name+': before 0040 the ledger is scanned\n'+b.join('\n'));
 assert.deepEqual(ledgerScan(a),[],name+': after 0040 no ledger scan\n'+a.join('\n'));
 assert.ok(a.some(d=>new RegExp('^SEARCH tmdb_retirement_decision USING (COVERING )?INDEX '+INDEX+'\\b').test(d)),name+': SEARCH by the new index\n'+a.join('\n'));
 const scans=a.filter(d=>/^SCAN /.test(d)&&!/json_each|^SCAN j\b|SCAN CONSTANT ROW|^SCAN \(subquery-\d+\)$/.test(d));
 assert.deepEqual(scans,[],name+': no base-table scan\n'+a.join('\n'));
 // The statement has no ORDER BY: the index may change the row order inside a column, which the resolver sorts (by seq, by text) before any use or digest.
 const normal=file=>Object.fromEntries(Object.entries(rows(file,text)[0]).map(([k,v])=>[k,k==='marker'?v:JSON.stringify(JSON.parse(v).map(r=>JSON.stringify(r)).sort())]));
 assert.deepEqual(normal(after),normal(before),name+': the snapshot reads the same rows');
}
const decisions=text=>JSON.parse(rows(after,text)[0].decisions_by_movie);
assert.equal(decisions(cases.requested).length,2,'movie 8 is retired under film:syn:7 and film:syn:2007');
assert.equal(decisions(cases.restored).length,4,'a restored movie id returns its two retires and their restores');
assert.equal(decisions(cases.retiredTwice).length,2,'a movie id retired under two Films returns both decisions');
assert.deepEqual(decisions(cases.miss),[]);assert.deepEqual(decisions(cases.empty),[]);

// ---- 4. legacy readers: retirement and restore parity --------------------------------------------------------------------------------------------------
const source=(file,pattern)=>pattern.exec(fs.readFileSync(file,'utf8'))[1];
const CATALOG=source('src/canonical-catalog-reader.js',/const RETIREMENT_SQL="([^"]+)";/);
const CLAIM=source('src/canonical-letterboxd-claim.js',/const RETIRED_SQL="([^"]+)";/);
const BY_FILM='SELECT * FROM tmdb_retirement_decision WHERE film_id=? ORDER BY seq';
const movies=['1','2','5','6','8','11','1000','2000','2001','999999'];
for(const statement of [CATALOG,CLAIM])for(const movie of movies){
 const text=statement.replace('?',q(movie));
 assert.deepEqual(rows(after,text),rows(before,text),movie);
 assert.deepEqual(ledgerScan(plan(after,text)),[],'the movie-id reader is index-served after 0040: '+movie);
}
assert.deepEqual(rows(after,CATALOG.replace('?',q('6'))),[],'a restored movie id is not retired');
assert.equal(rows(after,CATALOG.replace('?',q('8'))).length,1,'a retired movie id is retired');
assert.deepEqual(rows(after,CATALOG.replace('?',q('999999'))),[],'an unknown movie id is not retired');
for(const film of ['film:syn:7','film:syn:5','film:none']){
 const text=BY_FILM.replace('?',q(film));
 assert.deepEqual(rows(after,text),rows(before,text),film);
 assert.ok(plan(after,text).some(d=>d.includes('tmdb_retirement_decision_film')),'the film-id reader keeps its index: '+film);
}

// ---- 5. the ledger stays append-only ------------------------------------------------------------------------------------------------------------------
assert.notEqual(run(copyOf(after,'upd'),"UPDATE tmdb_retirement_decision SET movie_id='3' WHERE seq=1;").status,0,'update refused');
assert.notEqual(run(copyOf(after,'del'),'DELETE FROM tmdb_retirement_decision WHERE seq=1;').status,0,'delete refused');
assert.equal(run(copyOf(after,'down'),'UPDATE schema_contract SET version=39 WHERE id=1;').status!==0,true,'the version never goes down');

console.log('migration 0040 retirement movie index: ok');
