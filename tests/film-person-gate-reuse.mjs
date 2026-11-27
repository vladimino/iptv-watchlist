// AIR-688: the time-bounded, operation-scoped reuse of the canonical writer gate (src/film-person-authority.js `createGateReuse`, `readWriterGate`, `dropGateReuse`, `reuseSchemaFact`) through the REAL shared fenced writers
// (`mutateFilm`) on the real migrated schema (sqlite3 CLI D1 stand-in). Offline: no Worker, R2, TMDB or production access. What must hold: (1) without a scope nothing changes; (2) with a scope the four gate reads are
// skipped inside the TTL and read again after it; (3) every batch still asserts the marker in its own transaction, so a generation or cutover move AFTER the snapshot fails the batch whole (`film_person_fence`), writes
// nothing, drops the snapshot and the next call reads fresh; (4) only `open` is kept; (5) a snapshot is a copy; (6) a schema fact is kept only when positive; (7) the documented schema limit of the window.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {mutateFilm} from '../src/canonical-mutations.js';
import {countingEnv} from '../src/catalog-enrichment-drain.js';
import {createGateReuse,dropGateReuse,readWriterGate,reuseSchemaFact,GATE_REUSE_TTL_MS} from '../src/film-person-authority.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-gate-reuse-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});assert.equal(r.status,0,r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8'});assert.equal(r.status,0,r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n');
const template=path.join(root,'template.sqlite');
sqlite(template,chain);
sqlite(template,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;");
const preparedTemplate=path.join(root,'prepared.sqlite');
sqlite(preparedTemplate,chain);
sqlite(preparedTemplate,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;");
let worlds=0;
function world(reuse,source=template){
 const file=path.join(root,'w-'+(worlds++)+'.sqlite');fs.copyFileSync(source,file);
 const {env,counter}=countingEnv({DB:d1Standin(file)});
 if(reuse)env.gateReuse=reuse;
 return {file,env,counter};
}
const T='2026-11-27T10:00:00.000Z';
const film=(n,expected=0)=>({id:'film:tmdb:'+n,expectedRevision:expected,at:T,film:{contractVersion:1,originalTitle:'K'+n,externalIds:[{scheme:'tmdb',value:String(n),trusted:true}],aliases:[]}});
const filmCount=file=>rows(file,'SELECT COUNT(*) AS n FROM film')[0].n;
const gateReads=sql=>/film_person_authority|schema_contract|sqlite_master/.test(sql);

// 1. Without a scope every call reads the gate afresh (the behaviour before AIR-688).
{
 const w=world(null);
 const a=await readWriterGate(w.env),before=w.counter.statements;
 await readWriterGate(w.env);
 assert.equal(a.state,'open');
 assert.equal(w.counter.statements-before,before,'no scope: the second call costs as much as the first');
}

// 2. With a scope: the first call reads, calls inside the TTL read nothing, the TTL bounds the snapshot.
{
 let clock=1000;
 const scope=createGateReuse({ttlMs:50,now:()=>clock});
 const w=world(scope);
 await readWriterGate(w.env);const first=w.counter.statements;
 assert.ok(first>=3,'the first read is the full gate read');
 await readWriterGate(w.env);await readWriterGate(w.env);
 assert.equal(w.counter.statements,first,'inside the TTL no gate statement is issued');
 clock+=49;await readWriterGate(w.env);
 assert.equal(w.counter.statements,first,'one tick before the TTL ends the snapshot still serves');
 clock+=1;await readWriterGate(w.env);
 assert.equal(w.counter.statements,first*2,'at the TTL the gate is read again');
 assert.deepEqual({hits:scope.stats.hits,misses:scope.stats.misses},{hits:3,misses:2});
 assert.equal(GATE_REUSE_TTL_MS,5000);
 assert.throws(()=>createGateReuse({ttlMs:-1}),error=>error.code==='film_person_invalid');
}

// 3. A snapshot is a COPY: a producer fence bound onto one gate (the writers do) never reaches the next caller.
{
 const w=world(createGateReuse());
 const a=await readWriterGate(w.env);a.producerFence={kind:'chain',leaked:true};a.generation=99;
 const b=await readWriterGate(w.env);
 assert.equal(b.producerFence,undefined);
 assert.equal(b.generation,2);
}

// 4. Only `open` is kept. A held marker is read afresh every time, so a later reopen is seen at once; r2 and prepared throw and keep nothing.
{
 const scope=createGateReuse();
 const w=world(scope);
 const prepared=world(scope,preparedTemplate);
 await assert.rejects(readWriterGate(prepared.env),error=>error.code==='film_person_unavailable');
 assert.equal(scope.gate,null,'a prepared marker is refused and keeps nothing');
 sqlite(w.file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");
 assert.equal((await readWriterGate(w.env)).state,'held');
 assert.equal(scope.gate,null,'held is not kept');
 sqlite(w.file,"UPDATE film_person_authority SET cutover='open',generation=4 WHERE id=1");
 const reopened=await readWriterGate(w.env);
 assert.equal(reopened.state,'open');assert.equal(reopened.generation,4);
}

// 5. THE FENCE STAYS IN THE BATCH. A marker generation that moves after the snapshot fails the next writer's batch whole; nothing is written; the snapshot is dropped; the next call reads fresh and succeeds.
{
 const scope=createGateReuse();
 const w=world(scope);
 await mutateFilm(w.env,film(1));
 assert.ok(scope.gate,'the first writer kept the snapshot');
 // the marker moves held (generation 3) and open again (generation 4) between two writers: still `open`, but a new generation
 sqlite(w.file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");
 sqlite(w.file,"UPDATE film_person_authority SET cutover='open',generation=4 WHERE id=1");
 await assert.rejects(mutateFilm(w.env,film(2)),error=>error.code==='film_person_fence');
 assert.equal(filmCount(w.file),1,'the stale-gate batch wrote nothing');
 assert.equal(scope.gate,null,'a failed batch drops the snapshot');
 const done=await mutateFilm(w.env,film(2));
 assert.ok(done);
 assert.equal(filmCount(w.file),2);
 assert.equal(scope.gate.generation,4,'the fresh read carries the new generation');
}

// 6. The same for a cutover that moves to `held` after the snapshot: the batch refuses (the marker is asserted open INSIDE it), the next call refuses with film_person_held from a fresh read.
{
 const scope=createGateReuse();
 const w=world(scope);
 await mutateFilm(w.env,film(1));
 sqlite(w.file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");
 await assert.rejects(mutateFilm(w.env,film(2)),error=>error.code==='film_person_fence');
 assert.equal(filmCount(w.file),1);
 await assert.rejects(mutateFilm(w.env,film(2)),error=>error.code==='film_person_held');
 assert.equal(filmCount(w.file),1);
}

// 7. A stale entity revision under a live snapshot still conflicts (the revision assertion is in the batch too), and a concurrent writer of the same Film cannot be overwritten through a snapshot.
{
 const scope=createGateReuse();
 const w=world(scope);
 await mutateFilm(w.env,film(1));
 // a second writer (no scope) advances the Film behind the scoped one
 const rival={DB:d1Standin(w.file)};
 await mutateFilm(rival,{...film(1,1),film:{...film(1).film,originalTitle:'K1b'}});
 await assert.rejects(mutateFilm(w.env,{...film(1,1),film:{...film(1).film,originalTitle:'K1c'}}),error=>['film_person_revision_conflict','film_person_precondition'].includes(error.code));
 assert.equal(rows(w.file,"SELECT original_title AS t FROM film WHERE id='film:tmdb:1'")[0].t,'K1b');
}

// 8. A schema fact is kept only when positive and only inside the TTL.
{
 let clock=0;
 const scope=createGateReuse({ttlMs:10,now:()=>clock});
 const env={gateReuse:scope};
 const answers=['absent','ready','ready','ready'];let reads=0;
 const read=async()=>answers[reads++];
 const keep=value=>value==='ready';
 assert.equal(await reuseSchemaFact(env,'k',read,keep),'absent');
 assert.equal(await reuseSchemaFact(env,'k',read,keep),'ready');
 assert.equal(await reuseSchemaFact(env,'k',read,keep),'ready');
 assert.equal(reads,2,'a negative answer was not kept, a positive one was');
 clock=10;
 await reuseSchemaFact(env,'k',read,keep);
 assert.equal(reads,3,'the TTL bounds a schema fact');
 dropGateReuse(env);
 await reuseSchemaFact(env,'k',read,keep);
 assert.equal(reads,4,'a drop forgets it');
 assert.equal(await reuseSchemaFact({},'k',async()=>'x',keep),'x','no scope: a plain read');
}

// 9. The schema limit of the window. The schema contract is read at the snapshot and is not asserted in the batch (nor was it before: the read-then-commit window already existed). The database itself refuses to lower it
//    (trigger `schema_contract_downgrade`), and the writers' own tables are never dropped by a migration, so what the snapshot says about the schema cannot become false inside the TTL; the only schema move is forward.
{
 const scope=createGateReuse({ttlMs:100,now:()=>0});
 const w=world(scope);
 const first=await readWriterGate(w.env);
 const r=sqliteSync(['-bail',w.file],{input:'UPDATE schema_contract SET version=1 WHERE id=1;',encoding:'utf8'});
 assert.notEqual(r.status,0);
 assert.match(String(r.stderr),/schema_contract_downgrade/);
 assert.deepEqual(await readWriterGate(w.env),first);
 assert.equal(scope.stats.hits,1);
}

// 10. A different env object without the scope is unaffected by another env's snapshot.
{
 const scope=createGateReuse();
 const a=world(scope),b=world(null);
 await readWriterGate(a.env);
 const before=b.counter.statements;
 await readWriterGate(b.env);
 assert.ok(b.counter.statements-before>=3);
}

void gateReads;
console.log('film-person gate reuse: OK');
