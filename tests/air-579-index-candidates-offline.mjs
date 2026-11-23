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
exec(base,`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<19999)
 INSERT INTO published_epg_show (programme_run_id,film_id,channel_id,start_ms,end_ms,channel,epg_title,basis,match_reason)
 SELECT '${RUN}','film'||(i%4000),'ch'||(i%400),${START}+i*${MIN},0,'c',NULL,CASE WHEN i%4=0 THEN 'discovery' ELSE 'title_year' END,CASE WHEN i%4=0 THEN 'obs'||(i%1500) ELSE NULL END FROM n;
 WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<9999)
 INSERT INTO published_epg_show (programme_run_id,film_id,channel_id,start_ms,end_ms,channel,epg_title,basis,match_reason)
 SELECT '${OLD}','film'||(i%4000),'ch'||(i%400),${START}-1000000000+i*${MIN},0,'c',NULL,CASE WHEN i%4=0 THEN 'discovery' ELSE 'title_year' END,CASE WHEN i%4=0 THEN 'obs'||(i%1500) ELSE NULL END FROM n;`);
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
const DELETE="DELETE FROM published_epg_show WHERE programme_run_id='"+RUN+"' AND basis='discovery' AND match_reason='obs5'";
const A1='CREATE INDEX published_epg_show_by_match ON published_epg_show(programme_run_id, basis, match_reason)';
const A2="CREATE INDEX published_epg_show_discovery_by_match ON published_epg_show(programme_run_id, match_reason) WHERE basis='discovery'";
const variants={current:null,A1_full_index:A1,A2_partial_index:A2};
const deleteReport={};
const surviving={};
for(const [name,ddl] of Object.entries(variants)){
 const file=copyOf(base,'del-'+name);
 if(ddl)exec(file,ddl+';');
 const planText=plan(file,DELETE),stepCount=steps(copyOf(file,'del-steps-'+name),DELETE);
 const entries=ddl?Number(rows(file,'SELECT COUNT(*) AS n FROM published_epg_show INDEXED BY '+/INDEX (\w+)/.exec(ddl)[1]+(name==='A2_partial_index'?" WHERE basis='discovery'":'')+'')[0].n):0;
 exec(file,DELETE+';');
 surviving[name]=JSON.stringify(rows(file,'SELECT programme_run_id,film_id,channel_id,start_ms,basis,match_reason FROM published_epg_show ORDER BY 1,2,3,4'));
 deleteReport[name]={plan:planText.includes('USING INDEX')||planText.includes('USING COVERING')?planText.replace(/QUERY PLAN\s*/,'').slice(0,140):planText.replace(/QUERY PLAN\s*/,'').slice(0,140),vmSteps:stepCount,extraIndexEntries:entries};
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
const BDELETE="DELETE FROM published_epg_show WHERE programme_run_id='"+RUN+"' AND film_id='film5' AND basis='discovery' AND match_reason='obs5'";
const bFile=copyOf(base,'del-B');
const bPlan=plan(bFile,BDELETE),bSteps=steps(copyOf(bFile,'del-steps-B'),BDELETE);
assert.match(bPlan,/sqlite_autoindex_published_epg_show_1 \(programme_run_id=\? AND film_id=\?\)/);
deleteReport.B_film_scoped={plan:bPlan.replace(/QUERY PLAN\s*/,'').slice(0,140),vmSteps:bSteps,extraIndexEntries:0};
// Under the invariant (the rows of obs5 all name film5) B and the current statement agree; with an orphan row of another film B leaves it and the current statement removes it.
const cur=copyOf(base,'inv-cur'),viaB=copyOf(base,'inv-B');
const holders=rows(base,"SELECT DISTINCT film_id FROM published_epg_show WHERE programme_run_id='"+RUN+"' AND match_reason='obs5'").map(item=>item.film_id);
exec(cur,"INSERT INTO published_epg_show (programme_run_id,film_id,channel_id,start_ms,end_ms,channel,epg_title,basis,match_reason) VALUES ('"+RUN+"','orphanfilm','chZ',1,0,'c',NULL,'discovery','obs5');DELETE FROM published_epg_show WHERE programme_run_id='"+RUN+"' AND basis='discovery' AND match_reason='obs5';");
exec(viaB,"INSERT INTO published_epg_show (programme_run_id,film_id,channel_id,start_ms,end_ms,channel,epg_title,basis,match_reason) VALUES ('"+RUN+"','orphanfilm','chZ',1,0,'c',NULL,'discovery','obs5');"+holders.map(film=>"DELETE FROM published_epg_show WHERE programme_run_id='"+RUN+"' AND film_id='"+film+"' AND basis='discovery' AND match_reason='obs5';").join(''));
assert.equal(rows(cur,"SELECT COUNT(*) AS n FROM published_epg_show WHERE match_reason='obs5' AND programme_run_id='"+RUN+"'")[0].n,0,'the current statement removes the orphan too');
assert.equal(rows(viaB,"SELECT COUNT(*) AS n FROM published_epg_show WHERE match_reason='obs5' AND programme_run_id='"+RUN+"'")[0].n,1,'the film-scoped statement leaves a row that names another film: it needs the invariant');
report.assigned_rows_delete=deleteReport;

// ---- 2. the three film_external_id lookups -------------------------------------------------------------------------------------------------------------
const INDEX='CREATE INDEX film_external_id_by_value ON film_external_id(scheme, value)';
const withIndex=copyOf(base,'fei-index');exec(withIndex,INDEX+';');
const values=['v0-0','v1-7','v10-8','v50-3','nope','v200-2','v999-0','v123-12'];
const q1=value=>"SELECT film_id,trusted,conflicting FROM film_external_id WHERE scheme='tmdb' AND value='"+value+"'";
const q2=value=>"SELECT film_id,scheme,value,trusted,conflicting FROM film_external_id WHERE (scheme='tmdb' AND value='"+value+"') OR (scheme='letterboxd' AND value='"+value+"')";
const list=JSON.stringify(values);
const q3="SELECT film_id,scheme,value,trusted,conflicting FROM film_external_id WHERE scheme IN ('tmdb','letterboxd') AND value IN (SELECT value FROM json_each('"+list+"'))";
const q4="SELECT film_id,scheme,value,trusted,conflicting FROM film_external_id WHERE scheme IN ('tmdb','letterboxd') AND film_id IN (SELECT value FROM json_each('[\"f1\",\"f22\",\"f333\"]'))";
const sortJson=list=>JSON.stringify([...list].map(item=>JSON.stringify(item)).sort());
const lookups={q1_scheme_value:q1('v10-8'),q2_or_variant:q2('v10-8'),q3_value_in_json_each:q3,q4_film_id_in_json_each_control:q4};
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
assert.match(lookupReport.q1_scheme_value.planBefore,/SCAN film_external_id/);
assert.match(lookupReport.q1_scheme_value.planAfter,/film_external_id_by_value \(scheme=\? AND value=\?\)/);
assert.match(lookupReport.q2_or_variant.planAfter,/film_external_id_by_value/);
assert.match(lookupReport.q3_value_in_json_each.planAfter,/film_external_id_by_value/);
for(const name of ['q1_scheme_value','q2_or_variant','q3_value_in_json_each'])assert.ok(lookupReport[name].vmStepsAfter*10<lookupReport[name].vmStepsBefore,name+' is at least 10 times cheaper in VM steps');
assert.equal(lookupReport.q4_film_id_in_json_each_control.planBefore.includes('sqlite_autoindex_film_external_id_1'),true,'the film_id lookup already rides the primary key');
assert.equal(lookupReport.q4_film_id_in_json_each_control.planAfter.includes('sqlite_autoindex_film_external_id_1'),true,'and still does after the index');
report.film_external_id_lookups={...lookupReport,extraIndexEntriesPerRow:1,rowsIndexed:FEI};
console.log(JSON.stringify(report,null,1));
console.log('air-579 index candidates (offline): plans, parity, write cost');
