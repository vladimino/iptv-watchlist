// AIR-579: migration 0036 (two additive lookup indexes). Offline only: scratch sqlite databases built from the real chain; nothing is applied anywhere.
//  - the chain 33 -> 34 -> 35 -> 36, and the refusals (wrong predecessor, inconsistent 35, a second apply, an unexpected object);
//  - 0036 changes no data: a full dump before and after differs only by the two indexes and the schema_contract row;
//  - the real ASSIGNED_ROWS_DELETE and the three film_external_id lookups: plans, VM steps and result parity, orphan semantics, untrusted and conflicting rows, the film_id control;
//  - the build and write cost (index entries) on RCA-sized data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {migrated} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const read=name=>fs.readFileSync('migrations/'+name,'utf8');
const M34=read('0034_prediction_aux_authority.sql'),M35=read('0035_prediction_aux_import_receipts.sql'),M36=read('0036_epg_discovery_lookup_indexes.sql');
const run=(file,text)=>sqliteSync(['-bail',file],{input:text,encoding:'utf8',maxBuffer:1<<28});
const exec=(file,text)=>{const result=run(file,text);if(result.status!==0)throw new Error(result.stderr);return String(result.stdout);};
const rows=(file,text)=>{const result=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr);const out=String(result.stdout).trim();return out?JSON.parse(out):[];};
const version=file=>Number(rows(file,'SELECT version FROM schema_contract WHERE id=1')[0].version);
const objects=file=>rows(file,"SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").map(item=>item.type+':'+item.name);
const copyOf=(file,name)=>{const target=file.replace(/\.sqlite$/,'-'+name+'.sqlite');fs.copyFileSync(file,target);return target;};
const dump=file=>{const result=sqliteSync([file,'.dump'],{encoding:'utf8',maxBuffer:1<<30});if(result.status!==0)throw new Error(result.stderr);return String(result.stdout).split('\n');};
const steps=(file,text)=>{const result=sqliteSync([file],{input:'.stats vmstep\n'+text+';\n',encoding:'utf8',maxBuffer:1<<28});return Number(/VM-steps: (\d+)/.exec(String(result.stdout)+String(result.stderr))?.[1]);};
const plan=(file,text)=>String(run(file,'EXPLAIN QUERY PLAN '+text+';').stdout).replace(/\s+/g,' ');
const NEW=['published_epg_show_discovery_by_match','film_external_id_by_scheme_value'];

// ---- 1. the chain and the refusals ---------------------------------------------------------------------------------------------------------------------
const v33=migrated(33);
assert.equal(version(v33),33);
for(const name of NEW)assert.ok(!objects(v33).includes('index:'+name));
// 0036 on 33 and on 34 is refused before an index is created, and nothing changes.
const refuse=(file,reason)=>{
 const before=objects(file),ver=version(file),result=run(file,M36);
 assert.notEqual(result.status,0,reason+': the file aborts');
 assert.deepEqual(objects(file),before,reason+': no object created');assert.equal(version(file),ver,reason+': the version is unchanged');
};
refuse(copyOf(v33,'on33'),'on version 33');
const v34=copyOf(v33,'v34');exec(v34,M34);assert.equal(version(v34),34);
refuse(copyOf(v34,'on34'),'on version 34');
const v35=copyOf(v34,'v35');exec(v35,M35);assert.equal(version(v35),35);
// The helper chain (all migrations up to 35) is the same database shape.
assert.deepEqual(objects(migrated(35)),objects(v35),'the sequential chain equals the helper chain');

// Inconsistent 35: the version is 35 but a table of the predecessor is missing, or an expected index is, or a new index already exists.
{
 const missingTable=copyOf(v35,'bad-table');exec(missingTable,'DROP TABLE prediction_aux_seal;');refuse(missingTable,'a missing 0035 table');
 const missingIndex=copyOf(v35,'bad-index');exec(missingIndex,'DROP INDEX film_external_id_one_trusted;');refuse(missingIndex,'a missing predecessor index');
 const earlyIndex=copyOf(v35,'bad-early');exec(earlyIndex,'CREATE INDEX film_external_id_by_scheme_value ON film_external_id (scheme, value);');refuse(earlyIndex,'an unexpected pre-existing new index');
 assert.ok(!objects(earlyIndex).includes('index:published_epg_show_discovery_by_match'),'the other index is not created either');
 const wrongDefinition=copyOf(v35,'bad-def');exec(wrongDefinition,'CREATE INDEX published_epg_show_discovery_by_match ON published_epg_show (channel_id);');refuse(wrongDefinition,'a same-named index of another shape');
}

// ---- 2. RCA-sized data, then the real migration --------------------------------------------------------------------------------------------------------
const RUN='run-now',OLD='run-old',START=Date.parse('2026-11-22T12:00:00Z'),MIN=60000;
exec(v35,`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<19999)
 INSERT INTO published_epg_show (programme_run_id,film_id,channel_id,start_ms,end_ms,channel,epg_title,basis,match_reason)
 SELECT '${RUN}',CASE WHEN i%4=0 THEN 'film'||((i/4)%1500) ELSE 'other'||(i%4000) END,'ch'||(i%400),${START}+i*${MIN},0,'c',NULL,CASE WHEN i%4=0 THEN 'discovery' ELSE 'title_year' END,CASE WHEN i%4=0 THEN 'obs'||((i/4)%1500) ELSE NULL END FROM n;
 WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<9999)
 INSERT INTO published_epg_show (programme_run_id,film_id,channel_id,start_ms,end_ms,channel,epg_title,basis,match_reason)
 SELECT '${OLD}',CASE WHEN i%4=0 THEN 'film'||((i/4)%1500) ELSE 'other'||(i%4000) END,'ch'||(i%400),${START}-1000000000+i*${MIN},0,'c',NULL,CASE WHEN i%4=0 THEN 'discovery' ELSE 'title_year' END,CASE WHEN i%4=0 THEN 'obs'||((i/4)%1500) ELSE NULL END FROM n;
 UPDATE published_epg_authority SET programme_run_id='${RUN}' WHERE id=1;
 PRAGMA foreign_keys=OFF;
 WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<13999)
 INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json)
 SELECT 'f'||i,CASE WHEN i%14<7 THEN 'tmdb' WHEN i%14<11 THEN 'letterboxd' ELSE 'imdb' END,'v'||(i/14)||'-'||(i%14),CASE WHEN i%10=0 THEN 0 ELSE 1 END,0,NULL FROM n;
 INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json)
 SELECT 'dup'||rowid,scheme,value,0,1,NULL FROM film_external_id WHERE rowid%50=0;`);
const PES=Number(rows(v35,'SELECT COUNT(*) AS n FROM published_epg_show')[0].n),FEI=Number(rows(v35,'SELECT COUNT(*) AS n FROM film_external_id')[0].n);
const DISCOVERY=Number(rows(v35,"SELECT COUNT(*) AS n FROM published_epg_show WHERE basis='discovery'")[0].n);
assert.equal(PES,30000);assert.ok(FEI>14000);assert.equal(DISCOVERY,7500);

const before=copyOf(v35,'before'),after=copyOf(v35,'after');
const dumpBefore=dump(before);
const started=Date.now();exec(after,M36);const buildMs=Date.now()-started;
assert.equal(version(after),36);
assert.deepEqual(objects(after),[...objects(before),...NEW.map(name=>'index:'+name)].sort(),'exactly the two indexes are new');
// A second apply is refused and leaves the database as it is.
refuse(copyOf(after,'again'),'a second apply on version 36');

// Shape of the indexes: non-unique, one partial, the named columns.
const list=name=>rows(after,"SELECT name,\"unique\" AS uniq,partial FROM pragma_index_list('"+name+"')");
const partialIndex=list('published_epg_show').find(item=>item.name===NEW[0]),fullIndex=list('film_external_id').find(item=>item.name===NEW[1]);
assert.equal(partialIndex.uniq,0);assert.equal(partialIndex.partial,1);assert.equal(fullIndex.uniq,0);assert.equal(fullIndex.partial,0);
assert.deepEqual(rows(after,"SELECT name FROM pragma_index_info('"+NEW[0]+"') ORDER BY seqno").map(item=>item.name),['programme_run_id','match_reason']);
assert.deepEqual(rows(after,"SELECT name FROM pragma_index_info('"+NEW[1]+"') ORDER BY seqno").map(item=>item.name),['scheme','value']);
assert.match(rows(after,"SELECT sql FROM sqlite_master WHERE name='"+NEW[0]+"'")[0].sql,/WHERE basis = 'discovery'/);

// 0036 changes no data: the dump differs only by the two index definitions and the one schema_contract row.
const dumpAfter=dump(after);
const strip=lines=>lines.filter(line=>!line.startsWith('INSERT INTO schema_contract')&&!NEW.some(name=>line.includes(name)));
assert.deepEqual(strip(dumpAfter),strip(dumpBefore),'every table row, trigger, fence, lease and authority row is unchanged');
assert.equal(dumpAfter.filter(line=>line.startsWith('CREATE INDEX')&&NEW.some(name=>line.includes(name))).length,2);
assert.equal(dumpAfter.filter(line=>line.startsWith('INSERT INTO schema_contract')).length,1,'still one schema_contract row');
const contractBefore=dumpBefore.find(line=>line.startsWith('INSERT INTO schema_contract')),contractAfter=dumpAfter.find(line=>line.startsWith('INSERT INTO schema_contract'));
assert.notEqual(contractBefore,contractAfter);assert.match(contractAfter,/36/);

// Write cost: every index entry is a D1 rows_written. The partial index holds only the Discovery-assigned rows, the other one a row per external id.
const entries=(file,table,index,where)=>Number(rows(file,'SELECT COUNT(*) AS n FROM '+table+' INDEXED BY '+index+(where?' WHERE '+where:''))[0].n);
const entryReport={partialIndexEntries:entries(after,'published_epg_show',NEW[0],"basis='discovery'"),fullIndexEntries:entries(after,'film_external_id',NEW[1])};
assert.equal(entryReport.partialIndexEntries,DISCOVERY);assert.equal(entryReport.fullIndexEntries,FEI);

// ---- 3. the real statements ------------------------------------------------------------------------------------------------------------------------------
const DEPLOYED=/const ASSIGNED_ROWS_DELETE="([^"]+)";/.exec(fs.readFileSync('src/discovery-authority.js','utf8'))[1];
const KEY='obs5',FILM='film5',DELETE=DEPLOYED.replace('?',"'"+KEY+"'");
const count=(file,where)=>Number(rows(file,'SELECT COUNT(*) AS n FROM published_epg_show WHERE '+where)[0].n);
const NOW_KEY="programme_run_id='"+RUN+"' AND basis='discovery' AND match_reason='"+KEY+"'",OLD_KEY="programme_run_id='"+OLD+"' AND basis='discovery' AND match_reason='"+KEY+"'";
assert.equal(count(before,NOW_KEY),4);assert.equal(count(before,OLD_KEY),2);assert.equal(count(before,NOW_KEY+" AND film_id<>'"+FILM+"'"),0);
const planBefore=plan(before,DELETE),planAfter=plan(after,DELETE);
assert.match(planBefore,/published_epg_show_by_generation \(programme_run_id=\?\)/,'before: the run is searched and every row of it filtered');
assert.match(planAfter,/published_epg_show_discovery_by_match \(programme_run_id=\? AND match_reason=\?\)/,'after: the partial index');
const deleteSteps={before:steps(copyOf(before,'d-b'),DELETE),after:steps(copyOf(after,'d-a'),DELETE)};
assert.ok(deleteSteps.after*50<deleteSteps.before,'the delete is at least 50 times cheaper in VM steps: '+JSON.stringify(deleteSteps));
const survivors=file=>JSON.stringify(rows(file,'SELECT programme_run_id,film_id,channel_id,start_ms,basis,match_reason FROM published_epg_show ORDER BY 1,2,3,4'));
{
 const b=copyOf(before,'del-b'),a=copyOf(after,'del-a');
 exec(b,DELETE+';');exec(a,DELETE+';');
 assert.equal(PES-count(b,'1=1'),4);assert.equal(PES-count(a,'1=1'),4,'the same four rows');
 assert.equal(survivors(a),survivors(b),'identical survivors');
 assert.equal(count(a,OLD_KEY),2,'the historical run is untouched');
 // The semantics are those of the statement, not of the film: an orphan row of another film under the same key is removed in both.
 const ORPHAN="INSERT INTO published_epg_show (programme_run_id,film_id,channel_id,start_ms,end_ms,channel,epg_title,basis,match_reason) VALUES ('"+RUN+"','orphanfilm','chZ',1,0,'c',NULL,'discovery','"+KEY+"');";
 const ob=copyOf(before,'orph-b'),oa=copyOf(after,'orph-a');exec(ob,ORPHAN+DELETE+';');exec(oa,ORPHAN+DELETE+';');
 assert.equal(count(ob,NOW_KEY),0);assert.equal(count(oa,NOW_KEY),0,'the orphan is removed with the index too');assert.equal(survivors(oa),survivors(ob));
 // A row of the same key and run with another basis is not touched (the delete states basis = discovery) and is not in the partial index.
 const other="INSERT INTO published_epg_show (programme_run_id,film_id,channel_id,start_ms,end_ms,channel,epg_title,basis,match_reason) VALUES ('"+RUN+"','filmX','chY',2,0,'c',NULL,'title_year','"+KEY+"');";
 const xb=copyOf(before,'x-b'),xa=copyOf(after,'x-a');exec(xb,other+DELETE+';');exec(xa,other+DELETE+';');
 assert.equal(count(xa,"basis='title_year' AND match_reason='"+KEY+"'"),1);assert.equal(survivors(xa),survivors(xb));
}

const q1=value=>"SELECT film_id,trusted,conflicting FROM film_external_id WHERE scheme='tmdb' AND value='"+value+"'";
const q2=value=>"SELECT film_id,scheme,value,trusted,conflicting FROM film_external_id WHERE (scheme='tmdb' AND value='"+value+"') OR (scheme='letterboxd' AND value='"+value+"')";
const values=['v0-0','v1-7','v10-3','v10-8','v50-3','nope','v200-2','v999-0','v123-12'];
const q3="SELECT film_id,scheme,value,trusted,conflicting FROM film_external_id WHERE scheme IN ('tmdb','letterboxd') AND value IN (SELECT value FROM json_each('"+JSON.stringify(values)+"'))";
const q4="SELECT film_id,scheme,value,trusted,conflicting FROM film_external_id WHERE scheme IN ('tmdb','letterboxd') AND film_id IN (SELECT value FROM json_each('[\"f1\",\"f22\",\"f333\"]'))";
const sorted=list=>JSON.stringify([...list].map(item=>JSON.stringify(item)).sort());
assert.equal(rows(before,q1('v10-3')).length,1,'a TMDB hit');assert.equal(rows(before,q1('v10-8')).length,0,'a miss (a Letterboxd value under the TMDB scheme)');
const conflicting=rows(before,"SELECT value FROM film_external_id WHERE conflicting=1 AND scheme IN ('tmdb','letterboxd') LIMIT 1")[0].value,untrusted=rows(before,"SELECT value FROM film_external_id WHERE trusted=0 AND conflicting=0 AND scheme IN ('tmdb','letterboxd') LIMIT 1")[0].value;
for(const value of [...values,conflicting,untrusted])for(const text of [q1(value),q2(value)])assert.equal(sorted(rows(after,text)),sorted(rows(before,text)),'same rows for '+value);
assert.ok(rows(before,q2(conflicting)).length>=2,'a conflicting value returns both holders, with and without the index');
assert.equal(sorted(rows(after,q3)),sorted(rows(before,q3)));assert.ok(rows(before,q3).length>=4);
assert.equal(sorted(rows(after,q4)),sorted(rows(before,q4)));
const lookups={q1_hit:q1('v10-3'),q1_miss:q1('v10-8'),q2_tmdb:q2('v10-3'),q2_letterboxd:q2('v10-8'),q3:q3};
const lookupSteps={};
for(const [name,text] of Object.entries(lookups)){
 assert.match(plan(before,text),/SCAN film_external_id/,name+' before');
 assert.match(plan(after,text),/film_external_id_by_scheme_value/,name+' after');
 lookupSteps[name]={before:steps(copyOf(before,'l-b-'+name),text),after:steps(copyOf(after,'l-a-'+name),text)};
 assert.ok(lookupSteps[name].after*10<lookupSteps[name].before,name+' is at least 10 times cheaper in VM steps');
}
assert.ok(plan(before,q4).includes('sqlite_autoindex_film_external_id_1')&&plan(after,q4).includes('sqlite_autoindex_film_external_id_1'),'the film_id lookup rides the primary key before and after');
assert.equal(steps(copyOf(before,'c-b'),q4),steps(copyOf(after,'c-a'),q4),'and costs the same');
// The unique partial index of trusted rows still enforces its rule (the migration touched nothing of it).
assert.throws(()=>exec(copyOf(after,'uniq'),"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('uniq-a','tmdb','uniq-value',1,0,NULL),('uniq-b','tmdb','uniq-value',1,0,NULL);"));

console.log(JSON.stringify({rows:{published_epg_show:PES,discoveryAssigned:DISCOVERY,film_external_id:FEI},buildMs,indexEntries:entryReport,assignedRowsDelete:deleteSteps,lookups:lookupSteps}));
console.log('migration 0036: chain, refusals, no data change, plans and parity, write cost');
