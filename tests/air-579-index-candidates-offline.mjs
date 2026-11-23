// AIR-579: offline measurement of the two index candidates for the open hotspots of the RCA, on the real schema chain and RCA-sized synthetic data.
//   1. `ASSIGNED_ROWS_DELETE` (`src/discovery-authority.js`): DELETE FROM published_epg_show WHERE programme_run_id=(...) AND basis='discovery' AND match_reason=?
//   2. the three `film_external_id` lookups by (scheme, value) that read every trust state.
// Nothing here is a migration and nothing is applied anywhere: each candidate is created inside a scratch sqlite copy, measured and thrown away. Local only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {migrated} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const exec=(file,text)=>{const result=sqliteSync(['-bail',file],{input:text,encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr);return String(result.stdout);};
const rows=(file,text)=>{const result=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr);const out=String(result.stdout).trim();return out?JSON.parse(out):[];};
const steps=(file,text)=>{const result=sqliteSync([file],{input:'.stats vmstep\n'+text+';\n',encoding:'utf8',maxBuffer:1<<28});return Number(/VM-steps: (\d+)/.exec(String(result.stdout)+String(result.stderr))?.[1]);};
const plan=(file,text)=>exec(file,'EXPLAIN QUERY PLAN '+text+';').replace(/\s+/g,' ');
const copyOf=(file,name)=>{const target=file.replace(/\.sqlite$/,'-'+name+'.sqlite');fs.copyFileSync(file,target);return target;};

const base=migrated();
const RUN='run-now',OLD='run-old',START=Date.parse('2026-11-22T12:00:00Z'),MIN=60000;
// published_epg_show: RCA size, about 20 k shows in the published run, a quarter of them assigned by Discovery (`basis='discovery'`, `match_reason` = the observation key), plus a historical run that must stay.
// A Discovery-assigned row (`i%4=0`) belongs to observation key `obs<k>` with `k=(i/4)%1500` and names the ONE film of that key's verified decision (`film<k>`), as ADR 0142 decision 4 requires;
// every other row is a title/year match with an unrelated film. `obs5` is a populated key: four rows in the published run (i = 20, 6020, 12020, 18020) and two in the historical run.
exec(base,`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<19999)
 INSERT INTO published_epg_show (programme_run_id,film_id,channel_id,start_ms,end_ms,channel,epg_title,basis,match_reason)
 SELECT '${RUN}',CASE WHEN i%4=0 THEN 'film'||((i/4)%1500) ELSE 'other'||(i%4000) END,'ch'||(i%400),${START}+i*${MIN},0,'c',NULL,CASE WHEN i%4=0 THEN 'discovery' ELSE 'title_year' END,CASE WHEN i%4=0 THEN 'obs'||((i/4)%1500) ELSE NULL END FROM n;
 WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<9999)
 INSERT INTO published_epg_show (programme_run_id,film_id,channel_id,start_ms,end_ms,channel,epg_title,basis,match_reason)
 SELECT '${OLD}',CASE WHEN i%4=0 THEN 'film'||((i/4)%1500) ELSE 'other'||(i%4000) END,'ch'||(i%400),${START}-1000000000+i*${MIN},0,'c',NULL,CASE WHEN i%4=0 THEN 'discovery' ELSE 'title_year' END,CASE WHEN i%4=0 THEN 'obs'||((i/4)%1500) ELSE NULL END FROM n;
 UPDATE published_epg_authority SET programme_run_id='${RUN}' WHERE id=1;`);
// film_external_id: RCA size, about 14 k rows, three schemes, 10 % untrusted and 2 % conflicting duplicates of a value.
exec(base,`PRAGMA foreign_keys=OFF;
 WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<13999)
 INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json)
 SELECT 'f'||i,CASE WHEN i%14<7 THEN 'tmdb' WHEN i%14<11 THEN 'letterboxd' ELSE 'imdb' END,'v'||(i/14)||'-'||(i%14),CASE WHEN i%10=0 THEN 0 ELSE 1 END,0,NULL FROM n;
 INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json)
 SELECT 'dup'||rowid,scheme,value,0,1,NULL FROM film_external_id WHERE rowid%50=0;`);
const FEI=Number(rows(base,'SELECT COUNT(*) AS n FROM film_external_id')[0].n),PES=Number(rows(base,'SELECT COUNT(*) AS n FROM published_epg_show')[0].n);
assert.ok(FEI>14000&&PES===30000);

const report={published_epg_show_rows:PES,film_external_id_rows:FEI};

// ---- 1. the DELETE -------------------------------------------------------------------------------------------------------------------------------------
// The statement the Worker runs, read from the source (bound `?` replaced by the key) so the measurement cannot drift from it; the run comes from the authority pointer.
const DEPLOYED=/const ASSIGNED_ROWS_DELETE="([^"]+)";/.exec(fs.readFileSync('src/discovery-authority.js','utf8'))[1];
assert.match(DEPLOYED,/programme_run_id=\(SELECT programme_run_id FROM published_epg_authority WHERE id=1\) AND basis='discovery' AND match_reason=\?/);
const KEY='obs5',FILM='film5';
const DELETE=DEPLOYED.replace('?',"'"+KEY+"'");
assert.equal(rows(base,'SELECT programme_run_id AS run FROM published_epg_authority WHERE id=1')[0].run,RUN,'the authority points at the measured run');
const count=(file,where)=>Number(rows(file,'SELECT COUNT(*) AS n FROM published_epg_show WHERE '+where)[0].n);
const NOW_KEY="programme_run_id='"+RUN+"' AND basis='discovery' AND match_reason='"+KEY+"'",OLD_KEY="programme_run_id='"+OLD+"' AND basis='discovery' AND match_reason='"+KEY+"'";
assert.equal(count(base,NOW_KEY),4,'the measured key is populated in the published run');
assert.equal(count(base,OLD_KEY),2,'and in the historical run, whose rows must stay');
assert.equal(count(base,NOW_KEY+" AND film_id<>'"+FILM+"'"),0,'every row of the key names its one film (the invariant of ADR 0142 decision 4)');
const A1='CREATE INDEX published_epg_show_by_match ON published_epg_show(programme_run_id, basis, match_reason)';
const A2="CREATE INDEX published_epg_show_discovery_by_match ON published_epg_show(programme_run_id, match_reason) WHERE basis='discovery'";
const variants={current:null,A1_full_index:A1,A2_partial_index:A2};
const ROWS_BEFORE=PES;
const deleteReport={};
const surviving={};
for(const [name,ddl] of Object.entries(variants)){
 const file=copyOf(base,'del-'+name);
 if(ddl)exec(file,ddl+';');
 const planText=plan(file,DELETE),stepCount=steps(copyOf(file,'del-steps-'+name),DELETE);
 const entries=ddl?Number(rows(file,'SELECT COUNT(*) AS n FROM published_epg_show INDEXED BY '+/INDEX (\w+)/.exec(ddl)[1]+(name==='A2_partial_index'?" WHERE basis='discovery'":'')+'')[0].n):0;
 exec(file,DELETE+';');
 const deleted=ROWS_BEFORE-count(file,'1=1');
 assert.equal(deleted,4,name+' deletes exactly the four rows of the key in the published run');
 assert.equal(count(file,OLD_KEY),2,name+' leaves the historical run untouched');
 assert.equal(count(file,"NOT (programme_run_id='"+RUN+"' AND COALESCE(match_reason,'')='"+KEY+"')"),ROWS_BEFORE-4,name+' leaves every row that is not one of the four');
 surviving[name]=JSON.stringify(rows(file,'SELECT programme_run_id,film_id,channel_id,start_ms,basis,match_reason FROM published_epg_show ORDER BY 1,2,3,4'));
 deleteReport[name]={rowsDeleted:deleted,plan:planText.includes('USING INDEX')||planText.includes('USING COVERING')?planText.replace(/QUERY PLAN\s*/,'').slice(0,140):planText.replace(/QUERY PLAN\s*/,'').slice(0,140),vmSteps:stepCount,extraIndexEntries:entries};
}
assert.equal(surviving.A1_full_index,surviving.current,'the full index deletes exactly the same rows');
assert.equal(surviving.A2_partial_index,surviving.current,'the partial index deletes exactly the same rows');
assert.match(deleteReport.current.plan,/published_epg_show_by_generation \(programme_run_id=\?\)/,'today the run is searched and every row of it is filtered');
assert.match(deleteReport.A1_full_index.plan,/published_epg_show_by_match \(programme_run_id=\? AND basis=\? AND match_reason=\?\)/);
assert.match(deleteReport.A2_partial_index.plan,/published_epg_show_discovery_by_match \(programme_run_id=\? AND match_reason=\?\)/);
assert.ok(deleteReport.A1_full_index.vmSteps*50<deleteReport.current.vmSteps,'the full index is at least 50 times cheaper in VM steps');
assert.ok(deleteReport.A2_partial_index.vmSteps*50<deleteReport.current.vmSteps,'the partial index is at least 50 times cheaper in VM steps');
// Write cost: every index entry is a D1 `rows_written`. The full index adds one per show row, the partial index one per Discovery-assigned row only.
assert.equal(deleteReport.A1_full_index.extraIndexEntries,PES);
assert.equal(deleteReport.A2_partial_index.extraIndexEntries,Math.round(PES/4));
// A film-scoped DELETE (variant B) rides the primary key, needs no index, and is exact only while every row of a key names the film of its stored verified decision (ADR 0142 decision 4).
const BDELETE=DEPLOYED.replace('AND basis=','AND film_id=\''+FILM+'\' AND basis=').replace('?',"'"+KEY+"'");
assert.match(BDELETE,/film_id='film5'/);
const bFile=copyOf(base,'del-B');
const bPlan=plan(bFile,BDELETE),bSteps=steps(copyOf(bFile,'del-steps-B'),BDELETE);
assert.match(bPlan,/sqlite_autoindex_published_epg_show_1 \(programme_run_id=\? AND film_id=\?\)/);
exec(bFile,BDELETE+';');
assert.equal(ROWS_BEFORE-count(bFile,'1=1'),4,'under the invariant B deletes the same four rows');
assert.equal(count(bFile,OLD_KEY),2);
deleteReport.B_film_scoped={rowsDeleted:4,plan:bPlan.replace(/QUERY PLAN\s*/,'').slice(0,140),vmSteps:bSteps,extraIndexEntries:0};
// With an orphan row of another film under the same key, the current statement removes it and B leaves it: B needs the invariant.
const ORPHAN="INSERT INTO published_epg_show (programme_run_id,film_id,channel_id,start_ms,end_ms,channel,epg_title,basis,match_reason) VALUES ('"+RUN+"','orphanfilm','chZ',1,0,'c',NULL,'discovery','"+KEY+"');";
const cur=copyOf(base,'inv-cur'),viaB=copyOf(base,'inv-B');
exec(cur,ORPHAN+DELETE+';');exec(viaB,ORPHAN+BDELETE+';');
assert.equal(count(cur,NOW_KEY),0,'the current statement removes the orphan too');
assert.equal(count(viaB,NOW_KEY),1,'the film-scoped statement leaves the row that names another film');
report.assigned_rows_delete=deleteReport;

// ---- 2. the three film_external_id lookups -------------------------------------------------------------------------------------------------------------
const INDEX='CREATE INDEX film_external_id_by_value ON film_external_id(scheme, value)';
const withIndex=copyOf(base,'fei-index');exec(withIndex,INDEX+';');
const values=['v0-0','v1-7','v10-3','v10-8','v50-3','nope','v200-2','v999-0','v123-12'];
const q1=value=>"SELECT film_id,trusted,conflicting FROM film_external_id WHERE scheme='tmdb' AND value='"+value+"'";
const q2=value=>"SELECT film_id,scheme,value,trusted,conflicting FROM film_external_id WHERE (scheme='tmdb' AND value='"+value+"') OR (scheme='letterboxd' AND value='"+value+"')";
const list=JSON.stringify(values);
const q3="SELECT film_id,scheme,value,trusted,conflicting FROM film_external_id WHERE scheme IN ('tmdb','letterboxd') AND value IN (SELECT value FROM json_each('"+list+"'))";
const q4="SELECT film_id,scheme,value,trusted,conflicting FROM film_external_id WHERE scheme IN ('tmdb','letterboxd') AND film_id IN (SELECT value FROM json_each('[\"f1\",\"f22\",\"f333\"]'))";
const sortJson=list=>JSON.stringify([...list].map(item=>JSON.stringify(item)).sort());
// `v10-3` is a TMDB value (i=143, i%14=3), `v10-8` a Letterboxd one (i=148, i%14=8): the first is a hit and the second a miss for the TMDB-only statement, and both are hits for the OR statement.
const lookups={q1_tmdb_hit:q1('v10-3'),q1_tmdb_miss:q1('v10-8'),q2_or_tmdb_hit:q2('v10-3'),q2_or_letterboxd_hit:q2('v10-8'),q3_value_in_json_each:q3,q4_film_id_in_json_each_control:q4};
const expectedRows={q1_tmdb_hit:1,q1_tmdb_miss:0};
for(const [name,count] of Object.entries(expectedRows))assert.equal(rows(base,lookups[name]).length,count,name+' returns '+count+' row(s) without the index');
assert.ok(rows(base,lookups.q2_or_tmdb_hit).length>=1&&rows(base,lookups.q2_or_letterboxd_hit).length>=1,'the OR statement hits both schemes');
assert.ok(rows(base,q3).length>=4,'the json_each statement finds the present values');
const lookupReport={};
for(const [name,text] of Object.entries(lookups)){
 const before=plan(base,text),after=plan(withIndex,text);
 lookupReport[name]={planBefore:before.replace(/QUERY PLAN\s*/,'').slice(0,110),planAfter:after.replace(/QUERY PLAN\s*/,'').slice(0,130),vmStepsBefore:steps(copyOf(base,'fei-b-'+name),text),vmStepsAfter:steps(copyOf(withIndex,'fei-a-'+name),text)};
}
// Result parity for every trust state: untrusted, conflicting duplicates, absent values.
for(const value of values)for(const text of [q1(value),q2(value)])assert.equal(sortJson(rows(withIndex,text)),sortJson(rows(base,text)),'same rows for '+value);
assert.equal(sortJson(rows(withIndex,q3)),sortJson(rows(base,q3)));
assert.equal(sortJson(rows(withIndex,q4)),sortJson(rows(base,q4)));
const conflicting=rows(base,"SELECT value FROM film_external_id WHERE conflicting=1 AND scheme IN ('tmdb','letterboxd') LIMIT 1")[0].value,untrusted=rows(base,"SELECT value FROM film_external_id WHERE trusted=0 AND conflicting=0 AND scheme IN ('tmdb','letterboxd') LIMIT 1")[0].value;
for(const value of [conflicting,untrusted])assert.ok(rows(withIndex,q2(value)).length>=1&&sortJson(rows(withIndex,q2(value)))===sortJson(rows(base,q2(value))),'trust states are read as before');
for(const name of ['q1_tmdb_hit','q1_tmdb_miss']){assert.match(lookupReport[name].planBefore,/SCAN film_external_id/);assert.match(lookupReport[name].planAfter,/film_external_id_by_value \(scheme=\? AND value=\?\)/);}
for(const name of ['q2_or_tmdb_hit','q2_or_letterboxd_hit'])assert.match(lookupReport[name].planAfter,/film_external_id_by_value/);
assert.match(lookupReport.q3_value_in_json_each.planAfter,/film_external_id_by_value/);
for(const name of ['q1_tmdb_hit','q1_tmdb_miss','q2_or_tmdb_hit','q2_or_letterboxd_hit','q3_value_in_json_each'])assert.ok(lookupReport[name].vmStepsAfter*10<lookupReport[name].vmStepsBefore,name+' is at least 10 times cheaper in VM steps');
assert.equal(lookupReport.q4_film_id_in_json_each_control.planBefore.includes('sqlite_autoindex_film_external_id_1'),true,'the film_id lookup already rides the primary key');
assert.equal(lookupReport.q4_film_id_in_json_each_control.planAfter.includes('sqlite_autoindex_film_external_id_1'),true,'and still does after the index');
report.film_external_id_lookups={...lookupReport,extraIndexEntriesPerRow:1,rowsIndexed:FEI};
console.log(JSON.stringify(report,null,1));
console.log('air-579 index candidates (offline): plans, parity, write cost');
