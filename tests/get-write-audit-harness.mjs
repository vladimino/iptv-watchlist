// AIR-412: the audit harness must not be blind. A synthetic Worker that does each kind of effect on purpose is run through tests/get-write-audit-lib.mjs and every
// one has to be seen: an R2 put and delete, every D1 statement shape (and one the classifier cannot name), a file change without a classified statement, an outbound
// request with a body or a method other than GET, waitUntil, a continuation dispatch and a Workflow create. A read must report nothing. Nothing here uses the
// production bundle.
import assert from 'node:assert/strict';
import {buildScenario,Probe,effectsOf,d1Shape,normalizeSql} from './get-write-audit-lib.mjs';

// ---- the classifier of one statement ----
const cases=[
 ['SELECT * FROM t',null],['  select 1',null],['EXPLAIN QUERY PLAN SELECT 1',null],
 ['INSERT INTO t (a) VALUES (1)','INSERT INTO t'],['INSERT OR REPLACE INTO "t" (a) VALUES (1)','INSERT INTO t'],['REPLACE INTO t VALUES (1)','REPLACE INTO t'],
 ['UPDATE t SET a=1','UPDATE t'],['UPDATE OR IGNORE t SET a=1','UPDATE t'],['DELETE FROM t WHERE a=1','DELETE FROM t'],
 ['CREATE TABLE IF NOT EXISTS t (a)','CREATE t'],['CREATE UNIQUE INDEX i ON t (a)','CREATE i'],['DROP TABLE t','DROP t'],['ALTER TABLE t ADD COLUMN b','ALTER t'],
 ['-- comment\nUPDATE t SET a=1','UPDATE t'],['/* c */ DELETE FROM t','DELETE FROM t'],
 ['WITH x AS (SELECT 1) SELECT * FROM x',null],['WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x','INSERT INTO t'],
 ['PRAGMA user_version = 3','UNCLASSIFIED PRAGMA user_version = 3'],['VACUUM','UNCLASSIFIED VACUUM'],
];
for(const [sql,shape] of cases)assert.equal(d1Shape(sql),shape,sql);
assert.equal(normalizeSql("UPDATE a SET x='it''s', n=12 WHERE id=1"),'UPDATE a SET x=?, n=? WHERE id=?');

// ---- the instruments ----
const worker={
 async fetch(request,env,execution){
  const path=new URL(request.url).pathname;
  if(path==='/r2')await env.BUCKET.put('k1','{}');
  if(path==='/r2-delete'){await env.BUCKET.put('k2','{}');await env.BUCKET.delete('k2');}
  if(path==='/d1')for(const sql of ['CREATE TABLE audit_t (a)','INSERT INTO audit_t (a) VALUES (1)','UPDATE audit_t SET a=2','DELETE FROM audit_t'])await env.DB.prepare(sql).run();
  if(path==='/d1-batch')await env.DB.batch([env.DB.prepare('CREATE TABLE audit_b (a)').bind(),env.DB.prepare('INSERT INTO audit_b (a) VALUES (?)').bind(1)]);
  if(path==='/d1-unnamed')await env.DB.prepare('PRAGMA user_version = 7').run();
  if(path==='/d1-read')await env.DB.prepare('SELECT * FROM schema_contract').all();
  if(path==='/fetch-get')await fetch('https://example.test/a?x=1');
  if(path==='/fetch-post')await fetch('https://example.test/a',{method:'POST',body:'{}'});
  if(path==='/background')execution.waitUntil(Promise.resolve());
  if(path==='/dispatch')await execution.exports.DiscoveryContinuation.fetch(new Request('https://x.test/'));
  if(path==='/workflow')await env.EPG_WORKFLOW.create({});
  if(path==='/boom')throw new Error('boom');
  return new Response('{}');
 },
};
const probe=Probe({worker});
const scenario=await buildScenario('d1');
const run=async path=>effectsOf(await probe.run(scenario,path));
assert.deepEqual(await run('/'),[],'a read reports nothing');
assert.deepEqual(await run('/d1-read'),[],'a SELECT is a read');
assert.deepEqual(await run('/r2'),['put:k1']);
assert.deepEqual(await run('/r2-delete'),['put:k2','delete:k2']);
const d1Effects=['d1:CREATE audit_t','d1:INSERT INTO audit_t','d1:UPDATE audit_t','d1:DELETE FROM audit_t'];
assert.deepEqual(await run('/d1'),d1Effects);
assert.deepEqual(await run('/d1-batch'),['d1:CREATE audit_b','d1:INSERT INTO audit_b']);
assert.deepEqual(await run('/d1-unnamed'),['d1:UNCLASSIFIED PRAGMA user_version = 7']);
assert.deepEqual(await run('/fetch-get'),['fetch:GET https://example.test/a']);
assert.deepEqual(await run('/fetch-post'),['fetch:POST+body https://example.test/a']);
assert.deepEqual(await run('/background'),['background:1']);
assert.deepEqual(await run('/dispatch'),['dispatch:1']);
assert.deepEqual(await run('/workflow'),['workflow:1']);
const failed=await probe.run(scenario,'/boom');assert.equal(failed.status,599);assert.match(failed.error,/boom/);
// Two probes never share state: what the first wrote is not there for the second.
assert.deepEqual(await run('/d1'),d1Effects,'a repeat of a write is a separate, equal probe (the table is created again: nothing of the first probe is there)');
// An R2 scenario has no D1 binding and the Worker is not given one.
const r2=await buildScenario('r2');
const bare=await probe.run(r2,'/r2');assert.deepEqual(effectsOf(bare),['put:k1']);
probe.restore();
console.log('GET/HEAD audit harness: every kind of effect is seen, a read reports nothing, probes are independent');
