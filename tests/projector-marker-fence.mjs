// AIR-374 P1 / ADR 0117 (owner decision 1): EVERY SQL batch the enrichment projector writes asserts the Film/Person marker (mode, cutover open, generation) it read
// before its diff, independent of D1_ENRICHMENT_BULK and every other flag. The real migration chain (the real marker, triggers and foreign keys) runs in the sqlite3
// stand-in; R2 is a memory bucket; nothing here touches Cloudflare. Covered, with the grouped path OFF (the case ADR 0106 left unfenced) and ON:
// marker d1/generation 2 writes nothing; held, an unknown mode, a foreign cutover and an unreadable marker write nothing; a marker flip or a generation change between
// the read and the write fails the whole batch; r2 and prepared at the expected generation write the same rows with the same statements except the guard; a database
// without the marker table (legacy) writes as before and fails whole if the table appears mid-run; the guard costs no round trip and one statement per batch, and
// the marker read is one query inside the unchanged 800-query budget.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {projectorContext} from './d1-enrichment-context.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-marker-fence-'));
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
let databases=0;
const migrated=(opts={})=>{
 const file=path.join(root,'m-'+(databases++)+'.sqlite');
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 return {file,db:d1Standin(file,opts)};
};
const dropTriggers='DROP TRIGGER IF EXISTS film_person_authority_transition;DROP TRIGGER IF EXISTS film_person_authority_needs_baseline;';
const setMarker=(db,mode,cutover,generation)=>db.sql(dropTriggers+"UPDATE film_person_authority SET mode='"+mode+"',cutover='"+cutover+"',generation="+generation);
const count=(db,table)=>Number(Object.values(db.sql('SELECT COUNT(*) AS n FROM '+table)[0])[0]);
const rows=db=>count(db,'film')+count(db,'person')+count(db,'projection_state');
const T='2026-10-28T10:00:00.000Z';
const person=(id,name)=>({id,name,original:name});
const meta=record=>({...record,metadataAt:T,peopleVersion:1,peopleNamesVersion:2,synopsis:'Synopsis of '+record.id,synopsisFetchedAt:T,runtime:120});
const filmRecord=index=>({id:'w'+index,title:'Film '+index,original:'Film '+index,year:1995,tmdbId:String(100+index),url:'https://letterboxd.com/film/w'+index+'/',directors:[person('director/d'+index,'Director '+index)],actors:[person('actor/a'+index,'Actor '+index),person('actor/pool','Pool')]});
function sources(films){
 const bucket=new MemoryBucket();const put=(key,value)=>bucket.put(key,JSON.stringify(value));
 put('watchlist.json',{updatedAt:T,films});put('metadata.json',Object.fromEntries(films.map(item=>[item.id,meta(item)])));
 put('titles.json',{});put('people.json',{});put('epg/discovery-resolution.json',{});
 put('epg/published-generation.json',{phase:'published',programmeRunId:'run-1'});
 put('epg/generations/run-1/programme.json',{updatedAt:T,films:films.map(item=>({...item,shows:[]}))});
 put('epg/generations/run-1/discovered-films.json',{});
 return bucket;
}
const projector=projectorContext({log:()=>{}});
const FILMS=Array.from({length:4},(_,index)=>filmRecord(index+1));
const run=(db,bulk,options={})=>projector.runD1EnrichmentProjection({DB:db,BUCKET:sources(FILMS),D1_ENRICHMENT_WRITE:'on',...(bulk?{D1_ENRICHMENT_BULK:'on'}:{})},{queryBudget:1e9,wallMs:1e9,...options});
const isGuard=text=>/^INSERT INTO projection_fence/i.test(text)&&/film_person_authority|sqlite_master/.test(text);
const normalize=text=>text.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g,'T').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,'U').replace(/\b1[0-9]{12}\b/g,'N');
const MARKER_READ='SELECT mode,cutover,generation FROM film_person_authority WHERE id=1';
const isFilmWrite=statements=>statements.some(item=>/INSERT INTO (film|person)\b/.test(item.text));

// 1. A marker that is not the projector's writes nothing, bulk off and on.
for(const bulk of [false,true]){
 const label=bulk?'bulk on':'bulk off';
 for(const [name,mutate] of [['d1 generation 2',db=>setMarker(db,'d1','open',2)],['d1 held',db=>setMarker(db,'d1','held',3)]]){
  const {db}=migrated();mutate(db);
  const summary=await run(db,bulk);
  assert.deepEqual([summary.outcome,summary.reason,summary.inputKey],['deferred','authority_unavailable','film_person_authority'],label+' '+name);
  assert.equal(rows(db),0,label+' '+name+': nothing written');assert.equal(db.calls.batches,0,label+' '+name+': no batch of any kind');
 }
 for(const [name,read] of [
  ['an unknown mode',"SELECT 'closed' AS mode,'open' AS cutover,1 AS generation"],
  ['a foreign cutover',"SELECT 'prepared' AS mode,'closed' AS cutover,1 AS generation"],
  ['a malformed generation',"SELECT 'prepared' AS mode,'open' AS cutover,'x' AS generation"],
  ['a missing row',"SELECT mode,cutover,generation FROM film_person_authority WHERE id=2"],
  ['an unreadable marker',"SELECT nope FROM film_person_authority WHERE id=1"],
 ]){
  const {db}=migrated({rewrite:sql=>sql===MARKER_READ?read:sql});
  const summary=await run(db,bulk);
  assert.deepEqual([summary.outcome,summary.reason],['deferred','authority_unavailable'],label+' '+name);
  assert.equal(rows(db),0,label+' '+name);assert.equal(db.calls.batches,0);
 }
}

// 2. r2 and prepared at the expected generation write; the statements equal the legacy run's except the guard; rows equal.
const capture=async(prepare,bulk=false)=>{
 const batches=[];const fixture=migrated({onBatch:statements=>{batches.push(statements.map(item=>item.text));}});
 prepare(fixture.db);
 const summary=await run(fixture.db,bulk);
 return {summary,batches,db:fixture.db};
};
const without=batches=>batches.map(list=>list.filter(text=>!isGuard(text)).map(normalize));
const legacy=await capture(db=>db.sql('DROP TABLE film_person_authority'));
assert.equal(legacy.summary.outcome,'complete');assert.equal(count(legacy.db,'film'),4);
assert.ok(legacy.batches.every(list=>list.filter(isGuard).length===1&&/sqlite_master/.test(list.find(isGuard))),'legacy: every batch carries the legacy guard');
for(const [name,prepare] of [['r2 generation 0',()=>{}],['r2 generation 5',db=>setMarker(db,'r2','open',5)],['prepared generation 1',db=>setMarker(db,'prepared','open',1)]]){
 const result=await capture(prepare);
 assert.equal(result.summary.outcome,'complete',name);assert.equal(count(result.db,'film'),4,name);
 assert.deepEqual(without(result.batches),without(legacy.batches),name+': the same statements except the guard');
 assert.ok(result.batches.every(list=>list.filter(isGuard).length===1&&/film_person_authority/.test(list.find(isGuard))),name+': every batch carries exactly one marker guard');
 assert.ok(result.batches.every(list=>isGuard(list[1])),name+': the guard sits right after the lease fence');
 assert.equal(result.db.calls.batches,legacy.db.calls.batches,name+': the guard adds no round trip');
 assert.equal(result.db.calls.statements,legacy.db.calls.statements,name+': one guard statement per batch, as in legacy');
}
// The grouped path writes the same rows under the same marker.
const grouped=await capture(db=>setMarker(db,'prepared','open',1),true);assert.equal(grouped.summary.outcome,'complete');assert.equal(count(grouped.db,'film'),4);

// 3. Cost: the guard adds one statement per batch and no round trip; the marker read is ONE query, inside the unchanged budget.
{
 const guarded=await capture(db=>setMarker(db,'prepared','open',1));
 const stripped=migrated({rewrite:sql=>isGuard(sql)?'INSERT INTO projection_fence (held) SELECT 1 WHERE ? IS NOT NULL AND ? IS NOT NULL':sql});
 setMarker(stripped.db,'prepared','open',1);
 await run(stripped.db,false);
 assert.equal(guarded.db.calls.batches,stripped.db.calls.batches,'the same round trips with and without the guard');
 assert.equal(guarded.db.calls.statements,stripped.db.calls.statements,'the guard is a statement inside the batch, not a new one');
 const reads=[];const counted=migrated({onQuery:text=>{if(text===MARKER_READ)reads.push(text);}});
 setMarker(counted.db,'prepared','open',1);
 const after=await run(counted.db,false);
 assert.equal(reads.length,1,'exactly one marker read per run');
 assert.ok(after.queries<800,'the fixture stays far under the 800-query budget: '+after.queries);
}

// 4. A marker flip or generation change between the read and the write fails the whole batch (bulk off and on): nothing is written, the run is deferred.
for(const bulk of [false,true]){
 const label=bulk?'bulk on':'bulk off';
 for(const [name,mutate] of [
  ['the generation moves',db=>setMarker(db,'prepared','open',2)],
  ['the mode moves with the generation kept',db=>setMarker(db,'r2','open',1)],
  ['the marker leaves the projector (d1)',db=>setMarker(db,'d1','open',2)],
  ['the marker is held',db=>setMarker(db,'d1','held',2)],
 ]){
  let fired=0;let fixture;
  fixture=migrated({onBatch:async statements=>{if(isFilmWrite(statements)&&!fired++)mutate(fixture.db);}});
  setMarker(fixture.db,'prepared','open',1);
  const summary=await run(fixture.db,bulk);
  assert.deepEqual([summary.outcome,summary.reason,summary.inputKey],['deferred','authority_moved','film_person_authority'],label+' '+name+' '+JSON.stringify(summary.errors||[]));
  assert.equal(count(fixture.db,'film')+count(fixture.db,'person'),0,label+' '+name+': the batch failed whole');
  assert.equal(count(fixture.db,'projection_state'),0,label+' '+name+': no change key stored');
 }
}
// A move AFTER some batches committed stops every further write.
{
 let writes=0;let fixture;
 fixture=migrated({onBatch:async statements=>{if(isFilmWrite(statements)&&++writes===3)setMarker(fixture.db,'d1','open',2);}});
 setMarker(fixture.db,'prepared','open',1);
 const summary=await run(fixture.db,false);
 assert.deepEqual([summary.outcome,summary.reason],['deferred','authority_moved'],JSON.stringify([summary.errors,summary.writtenFilms,summary.writtenPeople]));
 assert.ok(count(fixture.db,'film')<4&&count(fixture.db,'person')>0,'the batches before the move committed, the one that met it and every later one wrote nothing');
 assert.equal(fixture.db.calls.batches,3,'no batch is sent after the one that lost the marker');
}

// 5. Legacy: a marker table that appears between the read and the write fails the batch whole.
{
 let fired=0;let fixture;
 fixture=migrated({onBatch:async statements=>{if(isFilmWrite(statements)&&!fired++)fixture.db.sql('CREATE TABLE film_person_authority (id INTEGER PRIMARY KEY, mode TEXT NOT NULL, cutover TEXT NOT NULL, generation INTEGER NOT NULL)');}});
 fixture.db.sql('DROP TABLE film_person_authority');
 const summary=await run(fixture.db,false);
 assert.deepEqual([summary.outcome,summary.reason],['deferred','authority_moved']);
 assert.equal(count(fixture.db,'film')+count(fixture.db,'person'),0);
}
// Legacy with the grouped path stays as ADR 0106 had it: no marker, nothing written.
{
 const {db}=migrated();db.sql('DROP TABLE film_person_authority');
 const summary=await run(db,true);
 assert.deepEqual([summary.outcome,summary.reason],['deferred','authority_unavailable']);assert.equal(rows(db),0);
 assert.ok(db.calls.queries<=4,'refused before the diff: the lease, the marker read and the release only: '+db.calls.queries);
}

// 6. Static: one source of the guard, the producers' dormant fence consumes it, and the projector carries no marker SQL of its own.
{
 const authority=fs.readFileSync('src/film-person-authority.js','utf8'),projectorSource=fs.readFileSync('src/d1-enrichment.js','utf8'),producers=fs.readFileSync('src/canonical-producers.js','utf8');
 assert.ok(authority.includes("EXISTS (SELECT 1 FROM film_person_authority WHERE id=1 AND mode=? AND cutover='open' AND generation=?)"));
 assert.doesNotMatch(projectorSource,/FROM film_person_authority/,'the projector carries no marker SQL of its own');
 assert.match(producers,/PROJECTOR_MARKER_CONDITION/);assert.doesNotMatch(producers,/FROM film_person_authority/,'the producers consume the projector condition, they do not copy it');
 assert.equal((projectorSource.match(/FilmPersonAuthority\.projectorGuard\(/g)||[]).length,2,'the per-batch guard is built from the one source in the per-entity path and the group cycle');
 assert.doesNotMatch(projectorSource,/if\(bulk\?\.expectedMarker\)await db\.run/,'the guard is not behind the grouped path');
}
fs.rmSync(root,{recursive:true,force:true});
console.log('projector-marker-fence: every projector batch asserts the marker, mode, cutover and generation, with the grouped path off and on; d1, held, unknown, malformed and unreadable markers write nothing; a move or a generation change between the read and the write fails the batch whole; r2 and prepared write the same statements as before except the guard; legacy is unchanged; the guard costs no round trip');
