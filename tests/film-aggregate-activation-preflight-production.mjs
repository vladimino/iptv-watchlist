// AIR-648: the READ-ONLY pre-activation preflight of the internal FilmAggregateV1 route (scripts/film-aggregate-activation-preflight-production.mjs). Offline only: a scratch sqlite database built from
// the real migration chain behind the D1 stand-in; no network, no credential value, no production access.
//  - arguments: the schema version the GO names is required, the row cap is bounded;
//  - the exact index definitions (0040 and 0043): present and exact, or a typed blocker (missing, unique, partial, another column, another table);
//  - the version, the five authority markers, the Film/Person marker, the single active profile and its lineage: each violation is a typed blocker, an open world passes;
//  - the size-only G1 evidence: records, parts, bytes, distinct etags against the accepted caps (8 parts / 480 000 bytes per fact record, the link index 40 parts), measured in SQL, bounded by the row cap
//    and never printing a key; over-cap records are an observation for the owner, not a blocker;
//  - the double capture: a state that moves between the two captures stops the run;
//  - every statement is a read (the stand-in records them), the database is byte-identical, and the printed report is sanitized (no Film id, lid, key or body).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {PRODUCTION_ACCOUNT_ID,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME} from '../scripts/published-epg-production.mjs';
import {parseArgs,indexExact,capture,evaluate,preflight,sanitize,run,G1,CAP_CEILINGS,DEFAULT_ROWS,REQUIRED_INDEXES,MARKERS,LINKS_KEY} from '../scripts/film-aggregate-activation-preflight-production.mjs';
import {UsageError} from '../scripts/letterboxd-claim-cohort-preflight-production.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-activation-preflight-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const argv=(...rest)=>['node','script',...rest];
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const HEAD=Number(chain.at(-1).slice(0,4));
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const AT='2026-11-28T10:00:00.000Z',RUN='run-1';
const q=value=>value==null?'NULL':typeof value==='number'?String(value):"'"+String(value).replace(/'/g,"''")+"'";
const sha256=text=>crypto.createHash('sha256').update(text).digest('hex');
const OPEN=[
 "UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1",
 "UPDATE ratings_domain_authority SET mode='d1',cutover='open' WHERE id=1",
 "UPDATE prediction_domain_authority SET mode='d1' WHERE id=1",
 "UPDATE owner_review_authority SET mode='d1',generation=1 WHERE id=1",
 `INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('${RUN}','published','${AT}','${'a'.repeat(64)}','${AT}')`,
 `UPDATE published_epg_authority SET mode='d1',cutover='open',programme_run_id='${RUN}',generation=1 WHERE id=1`,
 "UPDATE watchlist_authority SET mode='d1' WHERE id=1",
 `INSERT INTO prediction_profile (version,profile_hash,active,created_at,r2_key,content_sha256,lineage_json) VALUES (4,'p4',1,'${AT}','enrichment/profile.json','${'d'.repeat(64)}',NULL)`,
].join(';\n');
const schema=path.join(root,'schema.sqlite');
sqlite(schema,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
sqlite(schema,OPEN);
let n=0;
const blank=()=>{const file=path.join(root,'f-'+(n++)+'.sqlite');fs.copyFileSync(schema,file);return file;};
const fileSha=file=>sha256(fs.readFileSync(file));
const binding=(file,options)=>d1Standin(file,options);
const putDocument=(file,key,text,{partBytes=PART})=>{
 const etag=sha256(text),parts=[];for(let at=0;at<text.length;at+=partBytes)parts.push(text.slice(at,at+partBytes));if(!parts.length)parts.push('');
 sqlite(file,`DELETE FROM ratings_document WHERE key=${q(key)};`+parts.map((body,part)=>`INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES (${q(key)},${part},${q(body)},${q(etag)},${q(AT)});`).join(''));
};
const PART=60000;
const put=(file,key,bytes)=>putDocument(file,key,'x'.repeat(bytes),{partBytes:PART});

// ---- 1. arguments ----------------------------------------------------------------------------------------------------------------------------------
assert.throws(()=>parseArgs(argv()),/--expect-version/,'the schema version the GO names is required');
assert.throws(()=>parseArgs(argv('--expect-version','42')),/43 to/,'below the 0043 chain is refused');
assert.throws(()=>parseArgs(argv('--expect-version','x')),/integer/);
assert.throws(()=>parseArgs(argv('--expect-version','54','--rows','0')),/1 to/);
assert.throws(()=>parseArgs(argv('--expect-version','54','--rows',String(CAP_CEILINGS.rows+1))),/1 to/,'a cap above its ceiling is refused');
assert.throws(()=>parseArgs(argv('--expect-version','54','--unknown','1')),/unknown option/);
assert.deepEqual(parseArgs(argv('--expect-version','54')),{expectVersion:54,rows:DEFAULT_ROWS});
assert.deepEqual(parseArgs(argv('--expect-version','54','--rows','1000')),{expectVersion:54,rows:1000});
assert.ok(new UsageError('x') instanceof Error);

// ---- 2. the exact index definition ---------------------------------------------------------------------------------------------------------------------
const [movie,target]=REQUIRED_INDEXES;
const def=(spec,sql)=>({tbl_name:spec.table,sql});
assert.equal(indexExact(movie,def(movie,'CREATE INDEX tmdb_retirement_decision_movie ON tmdb_retirement_decision (movie_id)')),true);
assert.equal(indexExact(target,def(target,'CREATE INDEX film_redirect_by_target ON film_redirect(to_film_id)')),true);
assert.equal(indexExact(target,def(target,'CREATE INDEX IF NOT EXISTS "film_redirect_by_target" ON "film_redirect" ("to_film_id")')),true);
assert.equal(indexExact(target,def(target,'CREATE INDEX film_redirect_by_target\n  ON film_redirect (to_film_id);')),true,'whitespace and the trailing semicolon do not matter');
for(const bad of ['CREATE UNIQUE INDEX film_redirect_by_target ON film_redirect (to_film_id)','CREATE INDEX film_redirect_by_target ON film_redirect (to_film_id) WHERE to_film_id IS NOT NULL','CREATE INDEX film_redirect_by_target ON film_redirect (to_film_id, from_id)','CREATE INDEX film_redirect_by_target ON film_redirect (from_id)','CREATE INDEX film_redirect_by_target ON film_redirect (lower(to_film_id))','CREATE INDEX film_redirect_by_target ON film_redirect (to_film_id) -- x'])
 assert.equal(indexExact(target,def(target,bad)),false,bad);
assert.equal(indexExact(target,{tbl_name:'film',sql:'CREATE INDEX film_redirect_by_target ON film_redirect (to_film_id)'}),false,'another table');
assert.equal(indexExact(target,undefined),false);assert.equal(indexExact(target,{tbl_name:'film_redirect',sql:null}),false);

// ---- 3. an open world on the real chain passes; the report is sanitized ----------------------------------------------------------------------------------
const world=()=>{const f=blank();put(f,LINKS_KEY,1000);return f;};
let file=world();
const before=fileSha(file);
const executed=[];
const open=await preflight(binding(file,{onQuery:text=>executed.push(text)}),{expectVersion:HEAD});
assert.deepEqual([open.decision,open.blockers,open.observations,open.needsOwnerDecision],['pass',[],[],false]);
assert.deepEqual(open.facts.schema,{rows:1,version:HEAD});
assert.deepEqual(open.facts.indexes.map(item=>[item.name,item.present,item.exact]),[['tmdb_retirement_decision_movie',true,true],['film_redirect_by_target',true,true]],'the two real indexes of the chain read back exact');
assert.equal(open.facts.film.state,'open');
assert.deepEqual(open.facts.markers.map(item=>[item.table,item.servable]),MARKERS.map(item=>[item.table,true]));
assert.deepEqual(open.facts.profile,{active:1,version:4,lineageReadable:true});
assert.equal(open.facts.counts.film,0);assert.equal(open.facts.counts.film_redirect,0);
assert.ok(executed.length>0&&executed.every(text=>/^\s*(WITH|SELECT)/i.test(text)),'every statement is a read');
assert.ok(executed.length%2===0,'two identical captures');
assert.equal(fileSha(file),before,'the database is byte-identical');
const report=sanitize(open,{transport:{requests:executed.length,rowsRead:0,rowsWritten:0}});
const printed=JSON.stringify(report);
assert.ok(!/film:|letterboxd\/facts|tmdb_\d|"l\d/.test(printed),'no id, key or body in the report');
assert.equal(report.g1.caps.recordBytes,480000);assert.equal(G1.recordParts,8);assert.equal(G1.recordBytes,480000);assert.equal(G1.linksBytes,2400000);
assert.ok(report.limitations.length===2);

// ---- 4. every violation is a typed blocker -------------------------------------------------------------------------------------------------------------
const stops=async(mutate,expected,{expectVersion=HEAD}={})=>{
 const f=world();mutate(f);
 const out=await preflight(binding(f),{expectVersion});
 assert.equal(out.decision,'stop',expected);
 assert.ok(out.blockers.includes(expected),expected+' in '+JSON.stringify(out.blockers));
 return out;
};
await stops(()=>{},'schema_version_not_expected',{expectVersion:HEAD+1});
await stops(f=>sqlite(f,'DROP INDEX film_redirect_by_target'),'index_missing:film_redirect_by_target');
await stops(f=>sqlite(f,'DROP INDEX tmdb_retirement_decision_movie'),'index_missing:tmdb_retirement_decision_movie');
await stops(f=>sqlite(f,'DROP INDEX film_redirect_by_target;CREATE UNIQUE INDEX film_redirect_by_target ON film_redirect (to_film_id)'),'index_not_exact:film_redirect_by_target');
await stops(f=>sqlite(f,'DROP INDEX film_redirect_by_target;CREATE INDEX film_redirect_by_target ON film_redirect (to_film_id) WHERE to_film_id IS NOT NULL'),'index_not_exact:film_redirect_by_target');
await stops(f=>sqlite(f,'DROP INDEX tmdb_retirement_decision_movie;CREATE INDEX tmdb_retirement_decision_movie ON tmdb_retirement_decision (tv_id)'),'index_not_exact:tmdb_retirement_decision_movie');
await stops(f=>sqlite(f,"UPDATE ratings_domain_authority SET cutover='held' WHERE id=1"),'marker_not_servable:ratings_domain_authority');
await stops(f=>sqlite(f,"UPDATE prediction_domain_authority SET writes='held' WHERE id=1"),'marker_not_servable:prediction_domain_authority');
await stops(f=>sqlite(f,"UPDATE prediction_domain_authority SET mode='r2' WHERE id=1"),'marker_not_servable:prediction_domain_authority');
await stops(f=>sqlite(f,"UPDATE owner_review_authority SET mode='r2' WHERE id=1"),'marker_not_servable:owner_review_authority');
await stops(f=>sqlite(f,"UPDATE watchlist_authority SET mode='epg' WHERE id=1"),'marker_not_servable:watchlist_authority');
await stops(f=>sqlite(f,"UPDATE published_epg_authority SET cutover='held' WHERE id=1"),'marker_not_servable:published_epg_authority');
await stops(f=>sqlite(f,"UPDATE film_person_authority SET cutover='held',generation=generation+1 WHERE id=1"),'film_person_marker_not_open');
await stops(f=>sqlite(f,'DELETE FROM prediction_profile'),'active_profile_not_single');
await stops(f=>sqlite(f,"UPDATE prediction_profile SET lineage_json='not json {'"),'active_profile_lineage_unreadable');
// An owner marker that is HELD still serves its rows (the card: open or held); r2 does not.
{const f=world();sqlite(f,"UPDATE owner_review_authority SET writes='held' WHERE id=1");assert.equal((await preflight(binding(f),{expectVersion:HEAD})).decision,'pass');}

// ---- 5. size-only G1 evidence --------------------------------------------------------------------------------------------------------------------
{
 const f=world();
 put(f,'letterboxd/facts/films/a.json',100);put(f,'letterboxd/facts/films/b.json',G1.recordBytes);put(f,'letterboxd/facts/films/c.json',PART+1);
 const out=await preflight(binding(f),{expectVersion:HEAD});
 const g=out.facts.g1;
 assert.deepEqual([g.measured,g.records,g.maxParts,g.maxBytes,g.overParts,g.overBytes,g.mixedEtags,g.totalBytes],[true,3,G1.recordParts,G1.recordBytes,0,0,0,100+G1.recordBytes+PART+1],'exactly at the cap is within it');
 assert.deepEqual([out.decision,out.observations,out.needsOwnerDecision],['pass',[],false]);
 assert.deepEqual([g.links.present,g.links.parts,g.links.bytes,g.links.etags],[true,1,1000,1]);
 // One byte over the cap, and one record in nine parts: observations for the owner, not blockers (discovery_cap coverage).
 put(f,'letterboxd/facts/films/d.json',G1.recordBytes+1);
 const over=await preflight(binding(f),{expectVersion:HEAD});
 assert.deepEqual([over.facts.g1.overParts,over.facts.g1.overBytes,over.facts.g1.maxParts,over.facts.g1.maxBytes],[1,1,G1.recordParts+1,G1.recordBytes+1]);
 assert.deepEqual([over.decision,over.observations,over.needsOwnerDecision],['pass',['fact_records_over_the_g1_cap'],true]);
 // Mixed etags in one record (a torn replacement) are an observation too.
 sqlite(f,"INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES ('letterboxd/facts/films/m.json',0,'a','e1','"+AT+"'),('letterboxd/facts/films/m.json',1,'b','e2','"+AT+"')");
 const mixed=await preflight(binding(f),{expectVersion:HEAD});
 assert.equal(mixed.facts.g1.mixedEtags,1);assert.ok(mixed.observations.includes('fact_records_with_mixed_etags'));
 assert.ok(!JSON.stringify(sanitize(mixed)).includes('letterboxd/facts/films/'),'no key in the report');
 // The key range holds ONLY fact records: the link index and a neighbouring prefix are not counted among them.
 put(f,'letterboxd/facts/films0x.json',5);put(f,'letterboxd/facts/film.json',5);
 assert.equal((await preflight(binding(f),{expectVersion:HEAD})).facts.g1.records,mixed.facts.g1.records);
 // The link index over its cap, absent, or in more than one etag.
 const big=world();put(big,LINKS_KEY,G1.linksBytes+1);
 assert.ok((await preflight(binding(big),{expectVersion:HEAD})).observations.includes('link_index_over_the_g1_cap'));
 const nolinks=blank();
 assert.ok((await preflight(binding(nolinks),{expectVersion:HEAD})).observations.includes('link_index_absent'));
 // The measure is bounded by the row cap: over it the aggregate query is not run and the run stops.
 const wide=world();put(wide,'letterboxd/facts/films/a.json',PART*3);
 const capped=await preflight(binding(wide),{expectVersion:HEAD,rows:2});
 assert.equal(capped.decision,'stop');assert.ok(capped.blockers.includes('g1_measure_over_row_cap'));assert.equal(capped.facts.g1.measured,false);
 assert.equal(capped.facts.g1.recordPartRows,3,'the part rows are counted over the primary-key range first');
 // No document table at all: the evidence is unavailable, a blocker.
 const gone=world();sqlite(gone,'PRAGMA foreign_keys=OFF;DROP TABLE ratings_document');
 assert.ok((await preflight(binding(gone),{expectVersion:HEAD})).blockers.includes('g1_documents_unavailable'));
}

// ---- 6. the double capture fences movement -----------------------------------------------------------------------------------------------------------
{
 const f=world();let seen=0;
 const out=await preflight(binding(f,{onQuery:text=>{if(text.includes('FROM schema_contract')&&++seen===2)sqlite(f,"UPDATE ratings_domain_authority SET generation=generation+1 WHERE id=1");}}),{expectVersion:HEAD});
 assert.equal(out.decision,'stop');assert.ok(out.blockers.includes('state_moved_between_captures'));
 // evaluate() on two equal captures and two different ones, directly.
 const a=await capture(binding(world()),{});
 assert.equal(evaluate(a,JSON.parse(JSON.stringify(a)),{expectVersion:HEAD}).decision,'pass');
 const moved=JSON.parse(JSON.stringify(a));moved.counts.film=1;
 assert.deepEqual(evaluate(a,moved,{expectVersion:HEAD}).blockers,['state_moved_between_captures']);
}

// ---- 7. the operator over a stub transport: identity first, only reads on the wire, nothing written, a sanitized report -------------------------------------------------
{
 const f=world();
 const dump=()=>String(sqliteSync([f,'.dump'],{encoding:'utf8',maxBuffer:1<<30}).stdout);
 const worldBefore=dump();
 const wire=[];
 const stub=identity=>async(url,init={})=>{
  const method=String(init.method||'GET').toUpperCase();
  wire.push({method,body:init.body?JSON.parse(init.body):null});
  if(method==='GET')return new Response(JSON.stringify({success:true,result:identity}),{status:200});
  const body=JSON.parse(init.body);
  const sql=body.params?.length?body.sql.replace(/\?/g,()=>{const value=body.params[sql_index.i++];return typeof value==='number'?String(value):"'"+String(value).replace(/'/g,"''")+"'";}):body.sql;
  sql_index.i=0;
  const r=sqliteSync(['-json','-bail',f],{input:sql,encoding:'utf8',maxBuffer:1<<28});
  if(r.status!==0)return new Response(JSON.stringify({success:false,errors:[{message:String(r.stderr).slice(0,100)}]}),{status:400});
  const out=String(r.stdout).trim();
  return new Response(JSON.stringify({success:true,result:[{success:true,results:out?JSON.parse(out):[],meta:{rows_read:1,rows_written:0,changed_db:false}}]}),{status:200});
 };
 const sql_index={i:0};
 const env={D1_BACKFILL_ACCOUNT_ID:PRODUCTION_ACCOUNT_ID,D1_BACKFILL_API_TOKEN:'dummy-not-a-credential'};
 const logged=[];
 const report=await run({argv:argv('--expect-version',String(HEAD)),env,fetchImpl:stub({uuid:PRODUCTION_DATABASE_ID,name:PRODUCTION_DATABASE_NAME}),log:text=>logged.push(text)});
 assert.equal(report.decision,'pass',JSON.stringify(report.blockers));
 assert.equal(wire[0].method,'GET','the target identity is read first');
 const posts=wire.filter(item=>item.method==='POST');
 assert.ok(posts.length>0&&posts.every(item=>typeof item.body.sql==='string'&&item.body.batch===undefined&&/^\s*(select|with)\b/i.test(item.body.sql)),'every request on the wire is a single read');
 assert.equal(report.transport.rowsWritten,0);assert.equal(report.transport.requests,wire.length);
 assert.equal(dump(),worldBefore,'the database is byte-for-byte unchanged by the run');
 assert.equal(logged.length,1);
 assert.ok(!/film:|letterboxd\/facts|tmdb_\d/.test(logged[0]),'the printed report names no row');
 assert.deepEqual(JSON.parse(logged[0]).indexes.map(item=>item.exact),[true,true]);
 // A stopping state exits as a report with its blockers (the exit code is the script's concern).
 sqlite(f,'DROP INDEX film_redirect_by_target');
 const stopped=await run({argv:argv('--expect-version',String(HEAD)),env,fetchImpl:stub({uuid:PRODUCTION_DATABASE_ID,name:PRODUCTION_DATABASE_NAME}),log:()=>{}});
 assert.deepEqual([stopped.decision,stopped.blockers],['stop',['index_missing:film_redirect_by_target']]);
 // A wrong database identity stops the run before any statement; so does a wrong account.
 wire.length=0;
 await assert.rejects(()=>run({argv:argv('--expect-version',String(HEAD)),env,fetchImpl:stub({uuid:'00000000-0000-0000-0000-000000000000',name:'other'}),log:()=>{}}),/target_identity_mismatch/);
 assert.deepEqual(wire.map(item=>item.method),['GET'],'only the identity read went out');
 wire.length=0;
 await assert.rejects(()=>run({argv:argv('--expect-version',String(HEAD)),env:{...env,D1_BACKFILL_ACCOUNT_ID:'a'.repeat(32)},fetchImpl:stub({uuid:PRODUCTION_DATABASE_ID,name:PRODUCTION_DATABASE_NAME}),log:()=>{}}),error=>error.reason==='account_mismatch');
 assert.equal(wire.length,0,'nothing was sent to a wrong account');
 await assert.rejects(()=>run({argv:argv(),env,fetchImpl:async()=>{throw new Error('no request');},log:()=>{}}),/--expect-version/,'a missing version stops before any request');
}
console.log('film-aggregate-activation-preflight-production: arguments, exact index readback (0040, 0043), version and marker gates, active profile, size-only G1 evidence, double capture, read-only wire and sanitized report passed');
