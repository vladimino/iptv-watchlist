// AIR-373: the read-only preflight kit for applying schema 13..16. Offline: the statements are built from the migration files and are single SELECTs;
// the evaluator judges every state a production D1 could be in (clean v12, each step of the sequence, a half-applied or skipped migration, a live
// projector lease, a moved marker). Nothing here reads or writes any database or the network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {SEQUENCE,V12_TABLES,expectedObjects,loadExpected,assertReadOnly,inventorySql,preflightSteps,MARKER_STEPS,evaluatePreflight,unwrap} from '../scripts/schema-preflight.mjs';

const expected=loadExpected();
const NOW='2026-11-08T10:00:00.000Z';
const all=name=>expected[name].map(item=>({type:item.type,name:item.name}));
const upTo=count=>SEQUENCE.slice(0,count).flatMap(all);
const results=(version,applied,over={})=>({version:[{id:1,version,note:'n'}],prerequisites:V12_TABLES.map(name=>({name})),inventory:upTo(applied),projector_lease:[],...over});
const MARKER={marker:[{id:1,mode:'r2',cutover:'open',generation:0}],fence:[{id:1,ok:1}],baseline:[{id:1,state:'empty',reference:null}]};
const evaluate=(input,options={})=>evaluatePreflight(input,{expected,now:NOW,...options});

// 1. The expected objects come from the real migration files and cover every table, trigger, index and view they create.
{
 assert.deepEqual(SEQUENCE,['0013_film_person_authority','0014_localization_source','0015_film_admission','0016_tmdb_retirement_decision']);
 const names=name=>expected[name].map(item=>item.name);
 assert.ok(['film_person_authority','film_person_cas','film_person_baseline','canonical_revision','film_person_authority_transition','film_person_cas_no_delete'].every(item=>names(SEQUENCE[0]).includes(item)));
 assert.deepEqual(names(SEQUENCE[1]).sort(),['film_localization_source','person_localization_source']);
 assert.ok(['film_rated_admission','film_retention','film_rated_admission_tmdb','film_rated_admission_source_code'].every(item=>names(SEQUENCE[2]).includes(item)));
 assert.ok(['tmdb_retirement_decision','tmdb_retirement_current','tmdb_retirement_decision_retire'].every(item=>names(SEQUENCE[3]).includes(item)));
 assert.ok(!SEQUENCE.some(name=>names(name).includes('schema_contract_no_downgrade')),'the shared downgrade trigger proves nothing');
 assert.deepEqual(expectedObjects("-- CREATE TABLE ignored\nCREATE TABLE IF NOT EXISTS a_b (x); CREATE UNIQUE INDEX i1 ON a_b(x);"),[{type:'table',name:'a_b'},{type:'index',name:'i1'}]);
}

// 2. Every statement the kit produces is one read-only SELECT; anything else is refused.
{
 const steps=[...preflightSteps(expected),...MARKER_STEPS];
 assert.deepEqual(steps.map(step=>step.id),['version','prerequisites','inventory','projector_lease','marker','fence','baseline']);
 for(const step of steps){assert.equal(assertReadOnly(step.sql),step.sql);assert.match(step.sql,/^SELECT /);assert.ok(!step.sql.includes(';'));}
 for(const bad of ['UPDATE schema_contract SET version=13','SELECT 1; DROP TABLE film','INSERT INTO film SELECT 1','PRAGMA table_info(film)','DELETE FROM film','SELECT 1 FROM film; SELECT 2',' CREATE TABLE x(y)','WITH x AS (SELECT 1) DELETE FROM film','SELECT 1 DELETE FROM film','SELECT * FROM film DROP TABLE film'])assert.throws(()=>assertReadOnly(bad),/read-only SELECT/);
 assert.match(inventorySql(expected),/IN \('/);
 const sql=inventorySql(expected);
 for(const name of Object.values(expected).flat().map(item=>item.name))assert.ok(sql.includes("'"+name+"'"),name);
 assert.throws(()=>inventorySql({a:[{type:'table',name:"x'; DROP TABLE film; --"}]}),/unexpected object name/);
}

// 3. The states a production D1 can be in.
{
 // Clean schema 12: ready, the first migration is 0013, the whole sequence remains.
 let verdict=evaluate(results(12,0));
 assert.deepEqual([verdict.ok,verdict.state,verdict.version,verdict.next,verdict.remaining],[true,'ready_v12',12,SEQUENCE[0],SEQUENCE]);
 // One migration at a time: v13, v14, v15 each name the next one only.
 for(const [version,count] of [[13,1],[14,2],[15,3]]){
  verdict=evaluate(results(version,count,MARKER));
  assert.deepEqual([verdict.ok,verdict.state,verdict.next],[true,'at_v'+version,SEQUENCE[count]],'v'+version);
 }
 // Complete: nothing left to apply, a re-apply is never suggested, an initial marker raises no note.
 verdict=evaluate(results(16,4,MARKER));
 assert.deepEqual([verdict.ok,verdict.state,verdict.next,verdict.remaining,verdict.notes],[true,'complete',null,[],[]]);
 // A skipped migration: version 14 with 0015's tables present (a jump) or version 12 with 0013's tables present (a half apply) is inconsistent and names the objects.
 verdict=evaluate(results(14,3,MARKER));
 assert.equal(verdict.ok,false);assert.ok(verdict.blockers.some(item=>item.startsWith('partial_or_ahead:0015_film_admission')));
 assert.deepEqual([verdict.state,verdict.next,verdict.remaining],['inconsistent',null,[]],'nothing is suggested on an inconsistent state');
 verdict=evaluate(results(12,1));
 assert.ok(verdict.blockers.some(item=>item.startsWith('partial_or_ahead:0013_film_person_authority')));
 // A recorded version with a missing object (a table dropped or never created).
 const dropped=results(15,3,MARKER);dropped.inventory=dropped.inventory.filter(item=>item.name!=='film_retention');
 verdict=evaluate(dropped);
 assert.ok(verdict.blockers.some(item=>item.startsWith('missing_after_version:0015_film_admission:table:film_retention')));
 // Version row problems and a database below v12 or without its prerequisite tables.
 assert.equal(evaluate({...results(12,0),version:[]}).state,'unknown');
 assert.equal(evaluate({...results(12,0),version:[{id:1,version:12},{id:2,version:12}]}).blockers[0],'schema_contract_rows:2');
 assert.equal(evaluate({...results(12,0),version:[{id:1,version:'x'}]}).state,'unknown');
 assert.ok(evaluate(results(11,0)).blockers.includes('below_v12:11'));
 assert.ok(evaluate({...results(12,0),prerequisites:V12_TABLES.slice(1).map(name=>({name}))}).blockers.some(item=>item.startsWith('v12_tables_missing:film')));
 // A live projector lease blocks (the apply waits); an expired or released one does not.
 assert.ok(evaluate(results(12,0,{projector_lease:[{lease_id:'l',lease_until:'2026-11-08T10:05:00.000Z'}]})).blockers.includes('projector_lease_live:2026-11-08T10:05:00.000Z'));
 assert.equal(evaluate(results(12,0,{projector_lease:[{lease_id:'l',lease_until:'2026-11-08T09:00:00.000Z'}]})).ok,true);
 assert.equal(evaluate(results(12,0,{projector_lease:[{lease_id:null,lease_until:null}]})).ok,true);
 // The marker after 0013: unread is a blocker; moved is noted; moved before the schema is complete is a blocker (it is never what a clean apply leaves).
 assert.ok(evaluate(results(13,1)).blockers.includes('result_missing:marker'),'an omitted marker read is a missing result');
 assert.ok(evaluate(results(13,1,{marker:[],fence:[],baseline:[]})).blockers.includes('marker_unread'),'an empty marker read is unread');
 verdict=evaluate(results(16,4,{...MARKER,baseline:[{id:1,state:'loading',reference:'x'}]}));
 assert.ok(verdict.ok&&verdict.notes[0].startsWith('marker_not_initial'));
 verdict=evaluate(results(15,3,{...MARKER,marker:[{id:1,mode:'prepared',cutover:'open',generation:1}]}));
 assert.ok(verdict.blockers.includes('authority_moved_before_schema_complete'));
}

// 3b. Fail closed: a missing, null, non-array or failed probe result is never an empty one, so no success verdict can come from an incomplete read.
{
 const SUCCESS=new Set(['ready_v12','complete'].concat([13,14,15].map(v=>'at_v'+v)));
 const never=(input,label)=>{const verdict=evaluate(input);assert.equal(verdict.ok,false,label);assert.ok(!SUCCESS.has(verdict.state),label+': '+verdict.state);assert.equal(verdict.next,null,label);assert.deepEqual(verdict.remaining,[],label);return verdict;};
 const complete=(version,applied)=>results(version,applied,version>=13?MARKER:{});
 for(const [version,applied] of [[12,0],[13,1],[14,2],[15,3],[16,4]]){
  const keys=['version','prerequisites','inventory','projector_lease'].concat(version>=13?['marker','fence','baseline']:[]);
  assert.equal(evaluate(complete(version,applied)).ok,true,'the complete read passes at v'+version);
  for(const key of keys){
   const omitted={...complete(version,applied)};delete omitted[key];
   const verdict=never(omitted,'v'+version+' omitting '+key);
   assert.ok(verdict.blockers.includes('result_missing:'+key),'v'+version+' '+key);
   for(const bad of [null,undefined,{},'rows',7,{success:false,errors:['boom']},[{success:false}].length&&{results:[]}])never({...complete(version,applied),[key]:bad},'v'+version+' '+key+' = '+JSON.stringify(bad));
  }
 }
 // The marker, the fence and the baseline are single-row tables: a second row is as unreadable as none.
 for(const key of ['marker','fence','baseline']){
  const doubled=evaluate(results(13,1,{...MARKER,[key]:[...MARKER[key],...MARKER[key]]}));
  assert.equal(doubled.ok,false,key+' with two rows');assert.ok(doubled.blockers.includes('marker_unread'),key);
 }
 // A verified empty lease read ([]) and an empty inventory at a clean v12 stay valid and distinct from an absent one.
 assert.equal(evaluate(results(12,0,{projector_lease:[]})).ok,true);
 assert.equal(evaluate(results(12,0,{inventory:[]})).ok,true);
 // A lease row that cannot be dated is treated as live, never as free.
 assert.ok(evaluate(results(12,0,{projector_lease:[{lease_id:'l',lease_until:null}]})).blockers.some(item=>item.startsWith('projector_lease_live')));
 assert.ok(evaluate(results(12,0,{projector_lease:[{lease_id:'l'}]})).blockers.some(item=>item.startsWith('projector_lease_live')));
 assert.ok(evaluate(results(12,0,{projector_lease:[{lease_id:'l',lease_until:12345}]})).blockers.some(item=>item.startsWith('projector_lease_live')));
 assert.equal(evaluate(results(12,0,{projector_lease:[{lease_id:'l',lease_until:NOW}]})).ok,true,'a lease that ends exactly now is over');
 // A missing probe in an otherwise unknown state still reports every missing key; nothing at all is also unknown.
 assert.equal(evaluatePreflight(undefined,{expected,now:NOW}).ok,false);
 assert.equal(evaluatePreflight(null,{expected,now:NOW}).state,'unknown');
 assert.ok(evaluatePreflight({},{expected,now:NOW}).blockers.includes('result_missing:inventory'));
 // unwrap: the rows of a successful D1 response only; an error envelope, success false or a missing results array are null.
 assert.deepEqual(unwrap([{results:[{a:1}],success:true,meta:{}}]),[{a:1}]);
 assert.deepEqual(unwrap([{results:[],success:true}]),[]);
 for(const bad of [null,undefined,{},[],[{results:[{a:1}],success:false}],[{success:true}],[{results:'x',success:true}],{results:[],success:true},'x'])assert.equal(unwrap(bad),null,JSON.stringify(bad));
 // The verdict of an unwrapped failed probe cannot pass.
 never({...complete(12,0),inventory:unwrap([{results:[],success:false}])},'a failed inventory query');
 never({...complete(12,0),projector_lease:unwrap({error:'timeout'})},'a failed lease query');
}

// 4. Static: the kit is offline and the documented procedure exists.
{
 const text=fs.readFileSync('scripts/schema-preflight.mjs','utf8').replace(/\/\/.*$/gm,'');
 assert.ok(!/\bfetch\(|child_process|wrangler|\bhttps?:\/\/|process\.env|\.prepare\(|\.batch\(/.test(text),'no network, D1, shell or environment access');
 assert.ok(fs.existsSync('docs/runbooks/film-person-schema-preflight.md'));
 assert.ok(fs.readFileSync('docs/runbooks/README.md','utf8').includes('film-person-schema-preflight.md'));
}

console.log('schema-preflight: the statements are generated from migrations 0013..0016 and are single SELECTs; the evaluator names clean v12, each v13..v15 step, complete v16, a skipped or half-applied migration, a missing object, a live projector lease and a moved marker, and suggests nothing on an inconsistent state; the kit is offline');
