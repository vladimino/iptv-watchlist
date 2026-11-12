// AIR-374 E6 (docs/runbooks/film-person-e6-budget-measurement.md): the OFFLINE measurement kit scripts/film-person-e6-measure.mjs. No Worker, R2, D1, Cloudflare or connector access: the statements run on the sqlite stand-in over the real migration
// chain with a seeded fixture, and the verification, the summary and the ceiling formula are pure. Covered: every statement is one read-only SELECT with a cap and a classification; each statement answers what it claims on the fixture; the
// round-trip cost of one applyFilmFacts unit (pinned in the kit, measured here against the real adapter); each refusal and stop rule of `verify`; the percentile and ceiling arithmetic; fail-closed behaviour of the CLI.
// E6_SCRIPT points the file at a mutant copy of the script (tests/film-person-e6-measure-mutation.mjs).
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {applyFilmFacts} from '../src/canonical-producer-adapters.js';

const SCRIPT=process.env.E6_SCRIPT?path.resolve(process.env.E6_SCRIPT):path.resolve('scripts/film-person-e6-measure.mjs');
const K=await import(pathToFileURL(SCRIPT).href);
const {STATEMENTS,ORDER,CAPS,UNIT_COST,FORBIDDEN,emitSql,statementsDigest,verify,summarize,percentile,describe,ceilingOf}=K;
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-e6-measure-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const template=path.join(root,'template.sqlite');
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
assert.equal(sqlite(template,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
let n=0;
const copy=()=>{const file=path.join(root,'db-'+(n++)+'.sqlite');fs.copyFileSync(template,file);return file;};

// 1. The statements: one read-only SELECT each, a cap, a classification, a stable digest, nothing else.
{
 assert.equal(ORDER.length,14);
 assert.equal(new Set(ORDER).size,ORDER.length);
 const out=emitSql();
 assert.equal(out.readOnly,true);
 assert.equal(out.notAGo,true);
 assert.match(out.statementsDigest,/^[0-9a-f]{64}$/);
 assert.equal(out.statementsDigest,statementsDigest());
 assert.deepEqual(out.steps.map(step=>step.id),[...ORDER]);
 for(const step of out.steps){
  assert.match(step.sql,/^SELECT\b/,step.id);
  assert.ok(!step.sql.includes(';'),step.id);
  assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|PRAGMA|ATTACH|VACUUM|REINDEX)\b/i.test(step.sql),step.id);
  assert.ok(Number.isInteger(step.rowCap)&&step.rowCap>=1&&step.rowCap<=101,step.id+': a hard row cap');
  assert.ok(step.columns.length>=1&&step.purpose&&/D1 read/.test(step.classification)&&/no write/.test(step.classification),step.id);
  assert.ok(!/\b(payload_json|original_title|canonical_identity|synopsis|poster|url)\b/i.test(step.sql),step.id+': never selects a payload column');
  assert.ok(!/\bfilm_id\s+AS\b|\bSELECT\s+(m\.|p\.|c\.|w\.)?(film_id|person_id)\b/i.test(step.sql.split(' FROM ')[0]),step.id+': no identifier in the output list');
 }
 assert.deepEqual(CAPS,{rowsReadPerStatement:300000,rowsReadTotal:1500000,msPerStatement:5000,msTotal:60000,membersForDelta:20000});
 assert.equal(statementsDigest(),'38d50e82d454633ec9370f2981e05b88498a2a00809fdc2fb83b87bf2fe54543','the emitted statements are pinned: a change to any statement or row cap is a new GO text');
 assert.ok(fs.readFileSync(SCRIPT,'utf8').includes('sql:assertReadOnly(sql)'),'every statement passes assertReadOnly when it is built');
 assert.equal(Object.isFrozen(STATEMENTS)&&Object.isFrozen(CAPS)&&Object.isFrozen(UNIT_COST),true);
}

// 2. The statements on a seeded fixture (sqlite stand-in on the real migration chain).
const SEED=`
INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES
 ('film:tmdb:1',1,NULL,'T1',strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 day')),('film:tmdb:2',1,NULL,'T2',strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 day')),
 ('film:tmdb:3',1,NULL,'T3',strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')),('film:tmdb:4',1,NULL,'T4',strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')),
 ('film:tmdb:5',1,NULL,'T5',strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 day')),('film:tmdb:6',1,NULL,'T6',strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'));
INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:a','r-a',1,strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')),('person:b','r-b',1,strftime('%Y-%m-%dT%H:%M:%fZ','now','-40 day')),('person:c','r-c',1,strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'));
INSERT INTO watchlist_film (film_id,updated_at) VALUES ('film:tmdb:3','x'),('film:tmdb:4','x'),('film:tmdb:5','x'),('film:tmdb:6','x');
INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES ('film:tmdb:3','person:a','director',0),('film:tmdb:3','person:b','actor',0),('film:tmdb:4','person:a','actor',0),('film:tmdb:6','person:a','actor',0),('film:tmdb:6','person:b','actor',1),('film:tmdb:6','person:c','actor',2);
INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES
 ('g1','published','2026-11-09T04:00:00.000Z','x','2026-11-09T04:00:00.000Z'),('g2','published','2026-11-10T04:00:00.000Z','x','2026-11-10T04:00:00.000Z'),
 ('g3','published','2026-11-11T04:00:00.000Z','x','2026-11-11T04:00:00.000Z'),('gw','withheld','2026-11-12T04:00:00.000Z','x','2026-11-12T04:00:00.000Z');
INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES
 ('g1','programme',0,'film:tmdb:1'),('g1','programme',1,'film:tmdb:2'),('g1','programme',2,'film:tmdb:3'),
 ('g1','watchlist',0,'film:tmdb:1'),('g1','watchlist',1,'film:tmdb:2'),('g1','watchlist',2,'film:tmdb:3'),('g1','watchlist',3,'film:tmdb:4'),('g1','watchlist',4,'film:tmdb:6'),
 ('g2','programme',0,'film:tmdb:2'),('g2','programme',1,'film:tmdb:3'),('g2','programme',2,'film:tmdb:4'),
 ('g2','watchlist',0,'film:tmdb:2'),('g2','watchlist',1,'film:tmdb:3'),('g2','watchlist',2,'film:tmdb:4'),('g2','watchlist',3,'film:tmdb:5'),
 ('g3','programme',0,'film:tmdb:3'),('g3','programme',1,'film:tmdb:4'),('g3','programme',2,'film:tmdb:5'),('g3','programme',3,'film:tmdb:6'),
 ('g3','watchlist',0,'film:tmdb:3'),('g3','watchlist',1,'film:tmdb:4'),('g3','watchlist',2,'film:tmdb:5'),('g3','watchlist',3,'film:tmdb:6'),
 ('gw','programme',0,'film:tmdb:1');
INSERT INTO published_epg_show (programme_run_id,film_id,channel_id,start_ms) VALUES ('g3','film:tmdb:3','c',1),('g3','film:tmdb:4','c',2),('g2','film:tmdb:3','c',1);
INSERT INTO film_metadata (film_id,schema_version,genres_json,payload_json,updated_at) VALUES ('film:tmdb:1',1,'[]','{}','x'),('film:tmdb:2',1,'[]','{}','x'),('film:tmdb:3',1,'[]','{}','x');
INSERT INTO film_sync_state (film_id) VALUES ('film:tmdb:1'),('film:tmdb:2');
INSERT INTO film_dimension (film_id,dimension,status,updated_at) VALUES ('film:tmdb:1','identity','ok','x');
UPDATE published_epg_authority SET mode='d1',generation=3,watchlist_generation=3 WHERE id=1;`;
function seeded(){const file=copy();assert.equal(sqlite(file,SEED).status,0);return file;}
const envelope=(file,id,meta={rows_read:10,duration:1.5})=>[{success:true,results:rows(file,STATEMENTS[id].sql),meta}];
const collect=(file,meta)=>({_statementsDigest:statementsDigest(),_capturedAt:'2026-11-12T10:00:00.000Z',...Object.fromEntries(ORDER.map(id=>[id,envelope(file,id,meta)]))});
const file=seeded();
const good=collect(file);
const R=id=>good[id][0].results;
assert.deepEqual(R('schema'),[{version:19}]);
assert.deepEqual(R('film_person_marker'),[{mode:'r2',cutover:'open',generation:0}]);
assert.deepEqual(R('epg_authority'),[{mode:'d1',cutover:'open',generation:3,watchlist_generation:3}]);
assert.deepEqual(R('table_counts'),[{films:6,persons:3,credit_rows:6,watchlist_films:4,metadata_rows:3,sync_rows:2,dimension_rows:1,receipt_rows:0}]);
assert.deepEqual(R('generation_summary'),[{published_generations:3,oldest:'2026-11-09T04:00:00.000Z',newest:'2026-11-11T04:00:00.000Z'}]);
assert.deepEqual(R('generation_members'),[
 {rank:1,published_at:'2026-11-11T04:00:00.000Z',programme_members:4,watchlist_members:4,distinct_films:4,shows:2},
 {rank:2,published_at:'2026-11-10T04:00:00.000Z',programme_members:3,watchlist_members:4,distinct_films:4,shows:1},
 {rank:3,published_at:'2026-11-09T04:00:00.000Z',programme_members:3,watchlist_members:5,distinct_films:5,shows:0}]);
const byKind=id=>Object.fromEntries(R(id).map(row=>[row.kind,row]));
assert.deepEqual(byKind('membership_delta_1'),{
 programme:{kind:'programme',anchor:'2026-11-11T04:00:00.000Z',members:4,joined:2,departed:1},
 watchlist:{kind:'watchlist',anchor:'2026-11-11T04:00:00.000Z',members:4,joined:1,departed:1},
 any:{kind:'any',anchor:'2026-11-11T04:00:00.000Z',members:4,joined:1,departed:1}});
assert.deepEqual(byKind('membership_delta_2'),{
 programme:{kind:'programme',anchor:'2026-11-10T04:00:00.000Z',members:3,joined:1,departed:1},
 watchlist:{kind:'watchlist',anchor:'2026-11-10T04:00:00.000Z',members:4,joined:1,departed:2},
 any:{kind:'any',anchor:'2026-11-10T04:00:00.000Z',members:4,joined:1,departed:2}});
assert.equal(R('film_updates_by_day').reduce((s,row)=>s+row.films,0),4,'the two 30-day-old Films are outside the 14-day window');
assert.equal(R('person_updates_by_day').reduce((s,row)=>s+row.persons,0),2);
assert.deepEqual(R('credits_histogram'),[{credits:0,films:1},{credits:1,films:1},{credits:2,films:1},{credits:3,films:1}]);
assert.deepEqual(R('persons_of_watchlist'),[{persons_credited:3,credit_rows:6}]);
assert.deepEqual(R('person_credit_fanout'),[{films_per_person:1,persons:1},{films_per_person:2,persons:1},{films_per_person:3,persons:1}]);
assert.deepEqual(R('receipt_states'),[]);
// the statements never write: the database is byte-identical after the whole bundle
{const before=fs.readFileSync(file);collect(file);assert.ok(before.equals(fs.readFileSync(file)),'the read-only bundle left the database file unchanged');}
// the histogram buckets cap at 100 and 50 films, so the row caps are structural, not luck
{
 const big=seeded();
 const films=Array.from({length:130},(_,i)=>"('film:tmdb:"+(100+i)+"',1,NULL,'t','2026-01-01T00:00:00.000Z')").join(',');
 assert.equal(sqlite(big,'INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES '+films+";INSERT INTO watchlist_film (film_id,updated_at) SELECT id,'x' FROM film WHERE id LIKE 'film:tmdb:1__';INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:big','rb',1,'x');").status,0);
 assert.equal(sqlite(big,"INSERT INTO film_person_credit (film_id,person_id,role,ordinal) SELECT id,'person:big','actor',rowid FROM film WHERE id LIKE 'film:tmdb:1__'").status,0);
 const many=Array.from({length:105},(_,i)=>"('person:m"+i+"','rm"+i+"',1,'x')").join(',');
 const credits=Array.from({length:105},(_,i)=>"('film:tmdb:5','person:m"+i+"','actor',"+(10+i)+")").join(',');
 assert.equal(sqlite(big,'INSERT INTO person (id,role_id,contract_version,updated_at) VALUES '+many+';INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES '+credits).status,0);
 assert.deepEqual(rows(big,STATEMENTS.credits_histogram.sql).at(-1),{credits:100,films:1},'a Film with 105 credits lands in the 100-or-more bucket');
 const fan=rows(big,STATEMENTS.person_credit_fanout.sql);
 assert.deepEqual(fan.at(-1),{films_per_person:50,persons:1},'a Person with 100 Films lands in the 50-or-more bucket');
 assert.deepEqual(rows(big,STATEMENTS.credits_histogram.sql).find(row=>row.credits===1).films,101,'the 100 Films of the big Person plus the one-credit Film of the seed');
}

// the payload guard, on its own (a typed value can never carry most of these, so the pattern is a second line of defence)
for(const bad of ['film:abc','person:abc','film:tmdb:603','tmdb','https://x.test','http://x','a@b.c','/p.jpg','/x.png','run-1','run_1','run:1','RUN-1'])assert.ok(FORBIDDEN.test(bad),bad);
for(const fine of ['d1','open','prepared','applied','2026-11-11T04:00:00.000Z','abc','1234'])assert.ok(!FORBIDDEN.test(fine),fine);
// an empty database: no generation is a refusal with a reason, and a null timestamp is a valid value
{
 const empty=copy();
 assert.equal(sqlite(empty,"UPDATE published_epg_authority SET mode='d1',generation=3 WHERE id=1").status,0);
 const out=verify(collect(empty));
 assert.equal(out.ok,false);
 assert.ok(out.refusals.includes('rows_missing:generation_members:0'),JSON.stringify(out.refusals));
 assert.ok(!out.refusals.some(item=>item.startsWith('value_invalid:generation_summary')),'a null oldest/newest is a valid value');
}

// 3. Verification: the good bundle passes; every refusal and stop rule has its own case.
{
 const done=verify(good);
 assert.equal(done.ok,true,JSON.stringify(done.refusals));
 assert.deepEqual(done.refusals,[]);
 assert.deepEqual(done.stops,[]);
 assert.deepEqual(done.totals,{rowsRead:140,ms:21});
 assert.equal(verify(good,{allowPlainRows:false}).ok,true);
}
const mutate=(edit,options)=>{const copyOf=JSON.parse(JSON.stringify(good));edit(copyOf);return verify(copyOf,options);};
const refused=(edit,expected,options)=>{const out=mutate(edit,options);assert.equal(out.ok,false,expected);assert.ok(out.refusals.concat(out.stops).some(item=>item.startsWith(expected)),expected+' in '+JSON.stringify(out.refusals.concat(out.stops)));};
refused(c=>{delete c.schema;},'result_missing:schema');
refused(c=>{c.schema=null;},'result_missing:schema');
refused(c=>{c.schema='x';},'result_malformed:schema');
refused(c=>{c.schema=[5];},'result_malformed:schema');
refused(c=>{c.schema=[{success:true,results:[]},{success:true,results:[]}];},'result_malformed:schema');
refused(c=>{c.schema[0].success=false;},'result_failed:schema');
refused(c=>{c.schema[0].success=undefined;},'result_failed:schema');
refused(c=>{c.schema[0].results=null;},'result_failed:schema');
refused(c=>{c.schema[0].meta={};},'meta_missing:schema');
refused(c=>{c.schema[0].meta={rows_read:1};},'meta_missing:schema');
refused(c=>{c.schema[0].meta={duration:1};},'meta_missing:schema');
refused(c=>{c.schema[0].meta={rows_read:-1,duration:1};},'meta_missing:schema');
refused(c=>{c.schema[0].meta={rows_read:1,duration:-1};},'meta_missing:schema');
refused(c=>{c.schema=c.schema[0].results;},'plain_rows_without_meta:schema');
refused(c=>{c.schema[0].meta.rows_read=CAPS.rowsReadPerStatement+1;},'rows_read_cap:schema');
assert.equal(mutate(c=>{c.schema[0].meta.rows_read=CAPS.rowsReadPerStatement;}).ok,true,'exactly the cap passes');
refused(c=>{c.schema[0].meta.duration=CAPS.msPerStatement+1;},'duration_cap:schema');
assert.equal(mutate(c=>{c.schema[0].meta.duration=CAPS.msPerStatement;}).ok,true,'exactly the time cap passes');
refused(c=>{for(const id of ORDER)c[id][0].meta={rows_read:Math.ceil(CAPS.rowsReadTotal/ORDER.length)+1,duration:1};},'rows_read_total');
refused(c=>{for(const id of ORDER)c[id][0].meta={rows_read:1,duration:CAPS.msTotal/ORDER.length+1};},'duration_total');
refused(c=>{c.schema[0].results=[{version:19},{version:19}];},'row_cap:schema:2');
refused(c=>{c.schema[0].results=[];},'rows_missing:schema:0');
refused(c=>{c.generation_members[0].results=Array.from({length:9},(_,i)=>({...c.generation_members[0].results[0],rank:i+1}));},'row_cap:generation_members:9');
refused(c=>{c.schema[0].results=[{version:19,extra:1}];},'columns_mismatch:schema');
refused(c=>{c.schema[0].results=[{}];},'columns_mismatch:schema');
refused(c=>{c.schema[0].results=[{version:-1}];},'value_invalid:schema:version');
refused(c=>{c.schema[0].results=[{version:'19'}];},'value_invalid:schema:version');
refused(c=>{c.schema[0].results=[{version:1.5}];},'value_invalid:schema:version');
refused(c=>{c.film_person_marker[0].results[0].mode='tmdb';},'payload_pattern:film_person_marker');
refused(c=>{c.film_person_marker[0].results[0].mode='Mode';},'value_invalid:film_person_marker:mode');
refused(c=>{c.film_person_marker[0].results[0].cutover='maybe';},'value_invalid:film_person_marker:cutover');
refused(c=>{c.generation_summary[0].results[0].newest='2026-11-11';},'value_invalid:generation_summary:newest');
refused(c=>{c.film_updates_by_day[0].results[0].day='yesterday';},'value_invalid:film_updates_by_day:day');
refused(c=>{c.receipt_states[0].results=[{state:'film:tmdb:603',n:1}];},'value_invalid:receipt_states:state');
refused(c=>{c.unexpected=[];},'unknown_result:unexpected');
refused(c=>{delete c._statementsDigest;},'statements_digest_missing');
refused(c=>{c._statementsDigest='0'.repeat(64);},'statements_digest_mismatch');
refused(c=>{c._capturedAt='yesterday';},'captured_at_invalid');
refused(c=>{delete c._capturedAt;},'captured_at_invalid');
assert.equal(verify(null).ok,false);
assert.equal(verify([]).ok,false);
assert.deepEqual(verify('x').refusals,['results_not_an_object']);
// stop rules
refused(c=>{c.schema[0].results[0].version=18;},'schema_version:18');
refused(c=>{c.film_person_marker[0].results[0].cutover='held';},'film_person_held');
refused(c=>{c.epg_authority[0].results[0].mode='r2';},'epg_authority_not_d1_open:r2/open');
refused(c=>{c.epg_authority[0].results[0].cutover='held';},'epg_authority_not_d1_open:d1/held');
refused(c=>{c.generation_members[0].results[0].distinct_films=CAPS.membersForDelta+1;c.membership_delta_1[0].results.forEach(r=>{if(r.kind==='any')r.members=CAPS.membersForDelta+1;});},'delta_ran_over_size_cap:membership_delta_1');
refused(c=>{c.generation_members[0].results[1].watchlist_members=CAPS.membersForDelta+1;},'delta_ran_over_size_cap:membership_delta_2');
refused(c=>{c.generation_members[0].results[2].programme_members=CAPS.membersForDelta+1;},'delta_ran_over_size_cap:membership_delta_1');
assert.equal(mutate(c=>{c.generation_members[0].results[0].programme_members=CAPS.membersForDelta;}).ok,true,'exactly the size cap is allowed');
refused(c=>{c.generation_summary[0].results[0].newest='2026-11-12T04:00:00.000Z';},'generation_moved:summary_vs_members');
refused(c=>{c.membership_delta_1[0].results[0].anchor='2026-11-10T04:00:00.000Z';},'generation_moved:membership_delta_1');
refused(c=>{c.membership_delta_2[0].results[2].anchor='2026-11-11T04:00:00.000Z';},'generation_moved:membership_delta_2');
refused(c=>{c.membership_delta_2[0].results.find(r=>r.kind==='any').members=9;},'delta_members_mismatch:membership_delta_2');
refused(c=>{c.membership_delta_1[0].results.find(r=>r.kind==='any').members=9;},'delta_members_mismatch:membership_delta_1');
// notes, not refusals
{
 const out=mutate(c=>{c.table_counts[0].results[0].receipt_rows=2;c.receipt_states[0].results=[{state:'applied',n:2}];});
 assert.equal(out.ok,true);
 assert.ok(out.notes.includes('receipts_present:2')&&out.notes.includes('receipt_states_present:1'));
 const few=mutate(c=>{c.generation_members[0].results=c.generation_members[0].results.slice(0,2);});
 assert.ok(few.notes.includes('fewer_than_3_generations:2'));
}
// plain rows are a diagnostic, never a pass
{
 const plain=Object.fromEntries(Object.entries(good).map(([k,v])=>[k,k.startsWith('_')?v:v[0].results]));
 const diag=verify(plain,{allowPlainRows:true});
 assert.equal(diag.ok,false);
 assert.equal(diag.diagnosticOnly,true);
 assert.equal(diag.shapeOk,true);
 assert.ok(diag.notes.some(item=>item.startsWith('caps_unverifiable:schema')));
 assert.equal(verify(plain).ok,false);
 assert.ok(verify(plain).refusals.includes('plain_rows_without_meta:schema'));
 const bad=verify({...plain,schema:[{version:-3}]},{allowPlainRows:true});
 assert.equal(bad.shapeOk,false);
}

// 4. Percentiles and the summary.
{
 const h=[{value:1,count:5},{value:2,count:3},{value:10,count:2}];
 assert.equal(percentile(h,50),1);assert.equal(percentile(h,51),2);assert.equal(percentile(h,80),2);assert.equal(percentile(h,81),10);assert.equal(percentile(h,100),10);assert.equal(percentile(h,0),1);
 assert.equal(percentile([{value:1,count:0},{value:2,count:5}],0),2,'a bucket without members is never a percentile');
 assert.equal(percentile([],50),null);assert.equal(percentile([{value:7,count:0}],50),null);
 assert.deepEqual(describe([{value:10,count:2},{value:1,count:5},{value:2,count:3}]),{n:10,min:1,p50:1,p90:10,p95:10,p99:10,max:10,mean:3.1});
 assert.deepEqual(describe([{value:100,count:2},{value:3,count:1}],{capped:100}),{n:3,min:3,p50:100,p90:100,p95:100,p99:100,max:100,mean:67.67,cappedBucket:100,atCap:2});
 assert.equal(describe([]).max,null);
 const s=summarize(good,{limits:{queryBudgetPerStep:800,wallMsPerStep:60000,roundTripMs:50,cpuMsPerStep:100000,cpuMsPerUnit:10,changedShare:1}});
 assert.equal(s.ok,true);
 assert.deepEqual(s.perRun,[{observed:4,joined:1,departed:1,units:5},{observed:4,joined:1,departed:2,units:6}]);
 assert.equal(s.unitsPerRun,6);
 assert.deepEqual(s.departedMembers,{n:2,min:1,median:1,max:2});
 assert.equal(s.watchlistSize,4);
 assert.deepEqual(s.generations.observedFilms,{n:3,min:4,median:4,max:5});
 assert.deepEqual(s.generations.shows,{n:3,min:0,median:1,max:2});
 assert.equal(s.generations.published,3);assert.equal(s.generations.sampled,3);
 assert.deepEqual(s.creditsPerWatchlistFilm,{n:4,min:0,p50:1,p90:3,p95:3,p99:3,max:3,mean:1.5,cappedBucket:100,atCap:0});
 assert.deepEqual(s.filmsPerPerson,{n:3,min:1,p50:2,p90:3,p95:3,p99:3,max:3,mean:2,cappedBucket:50,atCap:0});
 assert.deepEqual(s.persons,{persons_credited:3,credit_rows:6});
 assert.deepEqual(s.filmUpdatesPerDay,{n:2,min:1,median:1,max:3});
 assert.deepEqual(s.personUpdatesPerDay,{n:1,min:2,median:2,max:2});
 assert.deepEqual(s.unitCost,UNIT_COST);
 assert.equal(s.ceiling.status,'complete');
 assert.equal(s.ceiling.proposed,10);
 assert.equal(s.ceiling.stepsPerRun,1);
 assert.deepEqual(s.d1,{rowsRead:140,ms:21});
 assert.ok(s.notes.some(item=>/changedShare/.test(item)));
 // a failed verification summarizes nothing
 const refusedSummary=summarize({...good,schema:null});
 assert.equal(refusedSummary.ok,false);assert.deepEqual(refusedSummary.refusals,['result_missing:schema']);assert.equal(refusedSummary.ceiling,undefined);
 assert.equal(summarize(good,{allowPlainRows:true}).ok,false,'the diagnostic mode never summarizes: a summary is only built from a verified pass');
}

// 5. The ceiling formula (inputs are the caller's; nothing is defaulted from the platform).
{
 const full={queryBudgetPerStep:800,wallMsPerStep:60000,roundTripMs:50,cpuMsPerStep:1000,cpuMsPerUnit:5,changedShare:1};
 const a=ceilingOf({limits:full,unitsPerRun:100});
 assert.equal(a.status,'complete');assert.equal(a.qUnit,38);
 assert.deepEqual(a.ceilings,{query:10,wall:15,cpu:100});
 assert.equal(a.binding,'query');assert.equal(a.proposed,10);assert.equal(a.upperBoundWithoutUnknowns,null);assert.equal(a.stepsPerRun,10);
 assert.equal(a.safety,0.5);
 assert.deepEqual(ceilingOf({limits:{...full,fixedQueries:20},unitsPerRun:1}).ceilings.query,10);
 assert.equal(ceilingOf({limits:{...full,fixedQueries:40}}).ceilings.query,9);
 assert.equal(ceilingOf({limits:{...full,fixedMs:3000}}).ceilings.wall,14);
 assert.equal(ceilingOf({limits:{...full,fixedCpuMs:100}}).ceilings.cpu,80);
 assert.equal(ceilingOf({limits:{...full,safety:0}}).ceilings.query,21);
 assert.equal(ceilingOf({limits:{...full,cpuMsPerUnit:3}}).ceilings.cpu,166,'the ceiling rounds down');
 assert.equal(ceilingOf({limits:{...full,queryBudgetPerStep:10,fixedQueries:50}}).ceilings.query,0,'a fixed part above the budget leaves no room, never a negative ceiling');
 assert.deepEqual(ceilingOf({limits:{...full,wallMsPerStep:Infinity}}).unknown,['wallMsPerStep']);
 assert.equal(ceilingOf({limits:{...full,safety:0.9}}).ceilings.query,2);
 assert.equal(ceilingOf({limits:{...full,changedShare:0.1}}).qUnit,16.4);
 assert.equal(ceilingOf({limits:{...full,changedShare:0}}).ceilings.query,28);
 const wall=ceilingOf({limits:{...full,wallMsPerStep:20000}});assert.equal(wall.binding,'wall');assert.equal(wall.proposed,5);
 const cpu=ceilingOf({limits:{...full,cpuMsPerUnit:100}});assert.equal(cpu.binding,'cpu');assert.equal(cpu.proposed,5);
 assert.equal(ceilingOf({limits:{...full,queryBudgetPerStep:10}}).proposed,0);
 assert.equal(ceilingOf({limits:{...full,queryBudgetPerStep:10},unitsPerRun:5}).stepsPerRun,null,'a zero ceiling has no step count');
 // unknowns: no proposal, only an upper bound of the known constraints, and a missing share is the worst case
 const noCpu=ceilingOf({limits:{queryBudgetPerStep:800,wallMsPerStep:60000,roundTripMs:50,changedShare:1}});
 assert.equal(noCpu.status,'incomplete');assert.equal(noCpu.proposed,null);assert.equal(noCpu.upperBoundWithoutUnknowns,10);assert.deepEqual(noCpu.unknown,['cpuMsPerStep','cpuMsPerUnit']);assert.equal(noCpu.stepsPerRun,undefined);
 const none=ceilingOf({limits:{}});
 assert.equal(none.status,'incomplete');assert.equal(none.proposed,null);assert.equal(none.upperBoundWithoutUnknowns,null);assert.equal(none.binding,null);assert.equal(none.unknown.length,6);assert.equal(none.qUnit,38);
 const noShare=ceilingOf({limits:{...full,changedShare:undefined}});assert.equal(noShare.status,'incomplete');assert.deepEqual(noShare.unknown,['changedShare']);assert.equal(noShare.qUnit,38);
 const nullShare=ceilingOf({limits:{...full,changedShare:null}});assert.deepEqual(nullShare.unknown,['changedShare']);
 assert.equal(ceilingOf({limits:{...full,safety:1}}).reason,'safety_out_of_range');
 assert.equal(ceilingOf({limits:{...full,safety:-0.1}}).reason,'safety_out_of_range');
 assert.equal(ceilingOf({limits:{...full,changedShare:1.5}}).reason,'changed_share_out_of_range');
 assert.equal(ceilingOf({limits:{...full,changedShare:-1}}).reason,'changed_share_out_of_range');
 assert.equal(ceilingOf({limits:{...full,changedShare:'1'}}).reason,'changed_share_out_of_range');
 assert.deepEqual(ceilingOf({limits:{...full,queryBudgetPerStep:'800'}}).unknown,['queryBudgetPerStep']);
 assert.deepEqual(ceilingOf({limits:{...full,roundTripMs:0}}).unknown,['roundTripMs']);
 assert.deepEqual(ceilingOf({limits:{...full,wallMsPerStep:NaN}}).unknown,['wallMsPerStep']);
 assert.deepEqual(ceilingOf({limits:{...full,queryBudgetPerStep:0}}).unknown,['queryBudgetPerStep']);
 assert.equal(ceilingOf().status,'incomplete');
}

// 6. The cost of one applyFilmFacts unit, measured on the sqlite stand-in against the real adapter and compared with the pinned numbers.
{
 const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
 const f=copy();
 const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:00.000Z');";
 for(const text of ["UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;","UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1","UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1",BASELINE])assert.equal(sqlite(f,text).status,0);
 const T='2026-11-11T10:00:00.000Z';
 const META={schemaVersion:1,year:1999,runtime:136,synopsis:'S',poster:'/p.jpg',url:'https://example.test/m',genres:['sci-fi'],peopleVersion:2,payload:{k:'v'},r2Key:null,contentSha256:null,updatedAt:T};
 const facts=(over={})=>({id:'film:tmdb:603',at:T,film:{contractVersion:1,originalTitle:'A',source:'tmdb'},metadata:META,sync:{metadataAt:T,synopsisFetchedAt:T,peopleNamesVersion:2,peopleLocalizedAt:T},watchlist:true,...over});
 const cost=async(event,input)=>{const db=d1Standin(f);const out=await applyFilmFacts({DB:db},{origin:'epg',event,input,now:()=>T});return {state:out.state,queries:db.calls.queries,batches:db.calls.batches,roundTrips:db.calls.queries+db.calls.batches};};
 const created=await cost('run-1',facts());
 assert.equal(created.state,'applied');
 assert.deepEqual({queries:created.queries,batches:created.batches,roundTrips:created.roundTrips},UNIT_COST.applied,'a new Film unit');
 const noop=await cost('run-2',facts());
 assert.equal(noop.state,'noop');
 assert.deepEqual({queries:noop.queries,batches:noop.batches,roundTrips:noop.roundTrips},UNIT_COST.noop,'an unchanged Film unit ends in the pre-plan');
 const changed=await cost('run-3',facts({film:{contractVersion:1,originalTitle:'B',source:'tmdb'}}));
 assert.equal(changed.state,'applied');
 assert.deepEqual({queries:changed.queries,batches:changed.batches,roundTrips:changed.roundTrips},UNIT_COST.applied,'a changed Film unit costs what a new one costs');
 assert.ok(UNIT_COST.applied.roundTrips>UNIT_COST.noop.roundTrips);
 assert.equal(UNIT_COST.applied.roundTrips,UNIT_COST.applied.queries+UNIT_COST.applied.batches);
 assert.equal(UNIT_COST.noop.roundTrips,UNIT_COST.noop.queries+UNIT_COST.noop.batches);
}

// 7. The CLI is fail-closed: usage 2, a refusal 1, output without payload.
{
 const run=(...args)=>spawnSync(process.execPath,[SCRIPT,...args],{encoding:'utf8'});
 const goodFile=path.join(root,'good.json'),badFile=path.join(root,'bad.json'),limitsFile=path.join(root,'limits.json');
 fs.writeFileSync(goodFile,JSON.stringify(good));
 fs.writeFileSync(badFile,JSON.stringify({...good,schema:[{success:true,results:[{version:18}],meta:{rows_read:1,duration:1}}]}));
 fs.writeFileSync(limitsFile,JSON.stringify({queryBudgetPerStep:800,wallMsPerStep:60000,roundTripMs:50,cpuMsPerStep:1000,cpuMsPerUnit:5,changedShare:1}));
 assert.equal(run().status,2);
 assert.equal(run('verify').status,2);
 const emit=run('emit-sql');assert.equal(emit.status,0);assert.equal(JSON.parse(emit.stdout).statementsDigest,statementsDigest());
 const cost=run('unit-cost');assert.equal(cost.status,0);assert.deepEqual(JSON.parse(cost.stdout).unitCost,JSON.parse(JSON.stringify(UNIT_COST)));
 const ok=run('verify',goodFile);assert.equal(ok.status,0);assert.equal(JSON.parse(ok.stdout).ok,true);assert.equal(JSON.parse(ok.stdout).rows,undefined,'the rows are not echoed');
 const stop=run('verify',badFile);assert.equal(stop.status,1);assert.deepEqual(JSON.parse(stop.stdout).stops,['schema_version:18']);
 const sum=run('summarize',goodFile,'--limits',limitsFile);assert.equal(sum.status,0);assert.equal(JSON.parse(sum.stdout).ceiling.proposed,10);
 const bare=run('summarize',goodFile);assert.equal(bare.status,0);assert.equal(JSON.parse(bare.stdout).ceiling.proposed,null);assert.equal(JSON.parse(bare.stdout).ceiling.status,'incomplete');
 assert.equal(run('summarize',badFile).status,1);
 const plainFile=path.join(root,'plain.json');
 fs.writeFileSync(plainFile,JSON.stringify(Object.fromEntries(Object.entries(good).map(([k,v])=>[k,k.startsWith('_')?v:v[0].results]))));
 assert.equal(run('verify',plainFile).status,1);
 const diag=run('verify',plainFile,'--allow-plain-rows');assert.equal(diag.status,1);assert.equal(JSON.parse(diag.stdout).diagnosticOnly,true);
 const plainSummary=run('summarize',plainFile,'--allow-plain-rows');assert.equal(plainSummary.status,1);assert.match(plainSummary.stdout,/caps_unverifiable/);
 assert.match(run('summarize',plainFile).stdout,/plain_rows_without_meta/);
}
// the file touches no network and no production path
{
 const text=fs.readFileSync(SCRIPT,'utf8');
 assert.ok(!/\bfetch\(|node:https?|node:net|wrangler|execSync|spawn|process\.env/.test(text),'no network, process or environment access');
}
console.log('film-person-e6-measure: ok');
