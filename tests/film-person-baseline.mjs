// AIR-373 stage A / ADR 0099 C6a: the offline baseline tooling: the parity ledger, the keyset D1 reader with its consistent-read check, the delta plan, the importer
// driver (checkpoint, resume, unknown outcomes, concurrent writer, generation and lease mismatch) and the baseline gate with its recorder. Fixtures and the sqlite3-CLI
// D1 stand-in only: no Worker, no R2, no production read or write; nothing here is bundled. Repeat against the real inputs in the production baseline (separate owner GOs).
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {CLASSES,DEFAULT_EXPLANATIONS,LIST_CAP,buildParityLedger,baselineGate,contextFromActual,encodeValue,expectedFromInputs,keyOf,makeGate,markBaselineLoading,planReconciliation,readD1State,readGate,readStableCut,readWitness,readerOf,recordBaselineVerified,runImport,sha256Hex,verifyAir286,VALUE_COLUMNS} from '../src/film-person-baseline.js';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-baseline-'));
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>name.replace(/\.sql$/,''));
let n=0;
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const sql=name=>fs.readFileSync('migrations/'+name+'.sql','utf8');
const code=expected=>error=>error.code===expected;
const AT='2026-11-08T10:00:00.000Z';
const NOW=()=>AT;
function database({upTo=chain.length}={}){
 const file=path.join(root,'bl-'+(n++)+'.sqlite');
 assert.equal(sqlite(file,chain.slice(0,upTo).map(sql).join('\n')).status,0);
 return file;
}
const db=file=>readerOf(d1Standin(file));
const env=file=>({DB:d1Standin(file)});
// A small canonical fixture: 3 Films, 4 Persons, credits (one D1-only tmdb credit), aliases, external ids, an owner localization, a retained Film and projector keys.
function seed(file){
 const insert=[
  "INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:1',1,'ident-1','One',?1),('film:tmdb:2',1,NULL,'Two',?1),('film:tmdb:3',1,NULL,'Three',?1),('film:retained',1,NULL,'Kept',?1)",
  "INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:director/1','director/1',1,?1),('person:actor/2','actor/2',1,?1),('person:actor/3','actor/3',1,?1),('person:tmdb_actor/9','tmdb_actor/9',1,?1)",
  "INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:tmdb:1','tmdb','1',1,0),('film:tmdb:2','tmdb','2',1,0),('film:tmdb:3','tmdb','3',1,0),('film:retained','tmdb','4',1,0)",
  "INSERT INTO person_external_id (person_id,scheme,value,trusted,conflicting) VALUES ('person:director/1','letterboxd','d1',1,0)",
  "INSERT INTO film_alias (film_id,kind,value) VALUES ('film:tmdb:1','title','Один'),('film:tmdb:2','title','Два')",
  "INSERT INTO person_alias (person_id,kind,value,provenance_json) VALUES ('person:director/1','name','Режиссёр',NULL),('person:tmdb_actor/9','name','Актёр','{\"source\":\"tmdb\",\"task\":\"AIR-286\"}')",
  "INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES ('film:tmdb:1','person:director/1','director',0),('film:tmdb:1','person:actor/2','actor',0),('film:tmdb:1','person:tmdb_actor/9','actor',1),('film:tmdb:2','person:actor/3','actor',0)",
  "INSERT INTO film_dimension (film_id,dimension,status,source,provenance_json,value,authority,attempts,updated_at) VALUES ('film:tmdb:1','localization','reviewed','owner','{}','Владелец','owner',0,?1),('film:tmdb:2','localization','provisional','wikidata','{}','Автомат',NULL,0,?1)",
  "INSERT INTO person_dimension (person_id,dimension,status,source,provenance_json,value,authority,attempts,updated_at) VALUES ('person:director/1','localization','reviewed','dictionary','{}','Режиссёр',NULL,0,?1)",
  "INSERT INTO watchlist_film (film_id,updated_at) VALUES ('film:tmdb:1',?1),('film:tmdb:2',?1)",
  "INSERT INTO film_retention (film_id,basis,watchlist,evidence_json,request_id,observed_at,updated_at) VALUES ('film:retained','watchlist_fact',0,'{}','r1','2026-11-01T00:00:00.000Z',?1)",
  "INSERT INTO projection_state (projection,kind,id,change_key,projected_at) VALUES ('enrichment','film','film:tmdb:1','k1',?1),('enrichment','film','film:tmdb:2','k2',?1),('enrichment','film','film:tmdb:3','k3',?1),('enrichment','film','film:retained','k4',?1),('enrichment','person','person:director/1','p1',?1),('enrichment','person','person:actor/2','p2',?1),('enrichment','person','person:actor/3','p3',?1)",
 ].map(text=>text.replaceAll('?1',"'"+AT+"'")).join(';\n');
 const r=sqlite(file,insert);assert.equal(r.status,0,r.stderr);
}
// A stable cut: the read takes the projector's lease, so it is made through readStableCut with a lease id of its own.
const readAll=(handle,options={})=>readStableCut(handle,{leaseId:'baseline:test',now:NOW,...options});
const AIR286='{"source":"tmdb","task":"AIR-286"}';
const toClasses=entries=>Object.fromEntries(Object.entries(entries).map(([name,list])=>[name,list.map(([k,v])=>[k,v])]));
const SOURCE={aggregateSha256:'a'.repeat(64),verified:true};
const everyClass=()=>Object.fromEntries(CLASSES.map(item=>[item.name,[]]));
const cloneSide=(side,classes)=>({classes:JSON.parse(JSON.stringify(classes??side.classes)),complete:true,consistent:true});

// 1. The ledger: counts, order-independent digests, classification, explanation, exceptions, bounds, determinism.
{
 const a=everyClass(),b=everyClass();
 for(let i=0;i<5;i++){a.film.push(['film:'+i,'["v"]']);b.film.push(['film:'+i,'["v"]']);}
 const same=await buildParityLedger({expected:{classes:a,complete:true,source:SOURCE},actual:{classes:b,complete:true,consistent:true}});
 assert.equal(same.ledger.totals.unexplained,0);
 assert.equal(same.ledger.classes.film.expected.digest,same.ledger.classes.film.actual.digest);
 assert.deepEqual([same.ledger.complete,same.ledger.readConsistent,same.diffs.length],[true,true,0]);
 // The digest does not depend on the order of the entries, and the ledger is deterministic.
 const shuffled=everyClass();shuffled.film=[...b.film].reverse();
 const again=await buildParityLedger({expected:{classes:a,complete:true,source:SOURCE},actual:{classes:shuffled,complete:true,consistent:true}});
 assert.equal(again.ledger.digest,same.ledger.digest);
 assert.equal((await buildParityLedger({expected:{classes:a,complete:true,source:SOURCE},actual:{classes:b,complete:true,consistent:true}})).ledger.digest,same.ledger.digest);
 // missing / extra / differs, each counted and listed by key only.
 const x=everyClass(),y=everyClass();
 x.film=[['film:1','["a"]'],['film:2','["b"]'],['film:3','["c"]']];y.film=[['film:1','["a"]'],['film:2','["CHANGED SECRET TITLE"]'],['film:4','["d"]']];
 const diff=await buildParityLedger({expected:{classes:x,complete:true,source:SOURCE},actual:{classes:y,complete:true,consistent:true}});
 assert.deepEqual([diff.ledger.classes.film.missing,diff.ledger.classes.film.extra,diff.ledger.classes.film.differs,diff.ledger.totals.unexplained],[1,1,1,3]);
 assert.deepEqual(diff.ledger.unexplainedList.map(item=>item.side+':'+item.key),['differs:film:2','missing:film:3','extra:film:4']);
 assert.ok(!JSON.stringify(diff.ledger).includes('SECRET'),'the ledger never carries a value');
 assert.notEqual(diff.ledger.digest,same.ledger.digest);
 // Explanations: a D1-only tmdb credit, a Person without a projector key, a retained Film are explained, each by its rule; a non-matching one stays unexplained.
 const e=everyClass(),d=everyClass();
 d.credit=[[keyOf('film:1','person:tmdb_actor/9','actor'),'1'],[keyOf('film:1','person:actor/2','actor'),'0']];
 d.person=[['person:orphan','["x"]']];d.personAlias=[[keyOf('person:orphan','name','x'),'null']];
 d.film=[['film:retained','["k"]']];d.filmAlias=[[keyOf('film:retained','title','K'),'null']];
 const context={explainedPersons:new Set(['person:orphan']),watchlistFilms:new Set(['film:1']),retainedFilms:new Set(['film:retained'])};
 const explained=await buildParityLedger({expected:{classes:e,complete:true,source:SOURCE},actual:{classes:d,complete:true,consistent:true},context});
 assert.equal(explained.ledger.totals.explained,5);
 assert.deepEqual(explained.diffs,[{class:'credit',side:'extra',key:keyOf('film:1','person:actor/2','actor')}]);
 assert.equal(explained.ledger.classes.credit.explained.byRule.d1_only_credit,1);
 assert.equal(explained.ledger.classes.film.explained.byRule.retained_film_film,1);
 // The explanation never covers a missing row or a differing one, or another class (a rule is per class and side).
 const m=everyClass();m.credit=[[keyOf('film:1','person:tmdb_actor/9','actor'),'1']];
 const missing=await buildParityLedger({expected:{classes:m,complete:true,source:SOURCE},actual:{classes:everyClass(),complete:true,consistent:true},context});
 assert.equal(missing.ledger.totals.unexplained,1,'a missing D1-only credit is not explained');
 // A rule explains only its own class: an extra Film whose id equals an unkeyed Person's id is not explained by the Person rule.
 const wrongClass=everyClass();wrongClass.film=[['person:orphan','["x"]']];
 const crossed=await buildParityLedger({expected:{classes:everyClass(),complete:true,source:SOURCE},actual:{classes:wrongClass,complete:true,consistent:true},context});
 assert.equal(crossed.ledger.totals.unexplained,1,'a rule of another class does not explain it');
 // Owner exceptions (class C) need a reason and the owner; otherwise they are ignored and counted.
 const exc=[{class:'film',key:'film:4',reason:'class C: no TMDB match',approvedBy:'owner'},{class:'film',key:'film:3',reason:'',approvedBy:'owner'},{class:'film',key:'film:2',reason:'x'}];
 const excepted=await buildParityLedger({expected:{classes:x,complete:true,source:SOURCE},actual:{classes:y,complete:true,consistent:true},exceptions:exc});
 assert.deepEqual([excepted.ledger.totals.explained,excepted.ledger.totals.unexplained,excepted.ledger.invalidExceptions],[1,2,2]);
 // Bounded lists with truncated flags.
 const big=everyClass();for(let i=0;i<LIST_CAP+30;i++)big.film.push(['film:b'+String(i).padStart(4,'0'),'["x"]']);
 const bounded=await buildParityLedger({expected:{classes:big,complete:true,source:SOURCE},actual:{classes:everyClass(),complete:true,consistent:true}});
 assert.deepEqual([bounded.ledger.totals.unexplained,bounded.ledger.unexplainedList.length,bounded.ledger.unexplainedTruncated],[LIST_CAP+30,LIST_CAP,true]);
 assert.equal(bounded.diffs.length,LIST_CAP+30,'the planner still gets every difference');
 // An unavailable class or an incomplete read makes the ledger incomplete.
 const partial=await buildParityLedger({expected:{classes:a,complete:true,source:SOURCE},actual:{classes:b,unavailable:['retirement'],complete:true,consistent:true}});
 assert.equal(partial.ledger.complete,false);assert.equal(partial.ledger.classes.retirement.unavailable,true);
 assert.equal((await buildParityLedger({expected:{classes:a,complete:true,source:SOURCE},actual:{classes:b,complete:false,consistent:true}})).ledger.complete,false);
 assert.equal((await sha256Hex('abc')).length,64);
}

// 2. The expected side: the projector's own view, normalized.
{
 const inputs={films:[{id:'film:tmdb:1',film:{contractVersion:1,canonicalIdentity:'i',originalTitle:'One',externalIds:[{scheme:'tmdb',value:1,trusted:true},{scheme:'tmdb_tv',value:9,trusted:false,conflicting:true}],aliases:[{kind:'title',value:'А'}],localization:{status:'reviewed',value:'В',provenance:{authority:'owner'}},redirects:[{from:'film:old',to:'film:tmdb:1'}]},watchlist:true,credits:[{personId:'person:director/1',role:'director',ordinal:0}]},{id:'film:tmdb:2',film:{},watchlist:false}],people:[{id:'person:director/1',person:{roleId:'director/1',externalIds:[{scheme:'letterboxd',value:'d',trusted:true}],aliases:[{value:'Р'}],localization:{status:'reviewed',value:'Р'}}}]};
 const c=expectedFromInputs(inputs,{retirement:[['film:tmdb:1',['retire','1','2']]]});
 assert.deepEqual([c.film.length,c.person.length,c.filmExternalId.length,c.filmAlias.length,c.credit.length,c.watchlist.length,c.redirect.length,c.retirement.length],[2,1,2,1,1,1,1,1]);
 assert.deepEqual(c.filmExternalId.find(([k])=>k.includes('tmdb_tv'))[1],'[0,1]');
 assert.deepEqual(c.filmLocalization,[['film:tmdb:1','["reviewed","owner","В"]']]);
 assert.deepEqual(c.watchlist,[['film:tmdb:1','[]']],'only a listed Film is expected in the watchlist, with the same empty value array as D1');
 assert.deepEqual(c.filmAlias,[[keyOf('film:tmdb:1','title','А'),'[]']]);
 assert.deepEqual(c.credit,[[keyOf('film:tmdb:1','person:director/1','director'),'[0]']]);
 assert.deepEqual(c.redirect,[['film:old','["film:tmdb:1"]']]);
 // One encoding: a count of columns and a type per class, nulls kept, text for ids, integers for flags; anything else is refused.
 assert.equal(encodeValue('retention',[true]),'[1]');assert.equal(encodeValue('retirement',[ 'retire',17266,9687]),'["retire","17266","9687"]');
 assert.equal(encodeValue('film',[1,null,undefined]),'[1,null,null]');
 for(const bad of [[],['x'],[1.5,null,null]])assert.throws(()=>encodeValue('film',bad),code('baseline_encoding'));
 assert.throws(()=>encodeValue('nope',[]),code('baseline_encoding'));
 assert.throws(()=>encodeValue('credit','0'),code('baseline_encoding'));
 for(const [name,columns] of Object.entries(VALUE_COLUMNS))assert.ok(CLASSES.some(item=>item.name===name)&&Array.isArray(columns),name);
 for(const item of CLASSES)assert.ok(Array.isArray(c[item.name]),item.name);
}

// 3. The D1 reader: keyset pages, resume, optional classes, bounded queries.
const fixture=database();seed(fixture);
const fullRead=await readAll(db(fixture),{pageSize:1000});
{
 assert.equal(fullRead.consistent,true);
 const counts=Object.fromEntries(Object.entries(fullRead.entries).map(([k,v])=>[k,v.length]));
 assert.deepEqual([counts.film,counts.person,counts.filmExternalId,counts.credit,counts.filmLocalization,counts.watchlist,counts.retention,counts.projectionKey,counts.ownerLink],[4,4,4,4,2,2,1,7,0]);
 assert.deepEqual(fullRead.unavailable,[],'all classes exist at the current schema');
 // Pages of one row read the same set (composite keyset boundaries), in at most one query per row plus one per class.
 const paged=await readD1State(db(fixture),{pageSize:1,queryBudget:1000});
 assert.equal(paged.done,true);
 assert.deepEqual(paged.entries,fullRead.entries);
 assert.ok(paged.queries<=Object.values(fullRead.entries).reduce((sum,list)=>sum+list.length+1,0));
 // A budget stop returns a state to resume from, and the resumed read equals the full read.
 let state=null,rounds=0,last;
 do{last=await readD1State(db(fixture),{state,pageSize:2,queryBudget:3});state=last;rounds++;assert.ok(rounds<200);}while(!last.done);
 assert.ok(rounds>1,'the budget interrupted the read');
 assert.deepEqual(last.entries,fullRead.entries);
 const stateAfterStop=await readD1State(db(fixture),{pageSize:2,queryBudget:2});
 assert.equal(stateAfterStop.done,false);assert.ok(stateAfterStop.queries<=2,'a bounded number of queries per call');
 // An optional class whose table is absent is unavailable, never empty; a failing required read is an error.
 const old=database({upTo:chain.findIndex(name=>name.startsWith('0016_'))});
 const oldRead=await readD1State(db(old),{pageSize:50});
 assert.deepEqual(oldRead.unavailable,['retirement']);
 assert.equal(oldRead.entries.retirement,undefined);
 const broken={all:async()=>{throw new Error('D1_ERROR: network');},get:async()=>null};
 await assert.rejects(()=>readD1State(broken,{}),code('baseline_read_unavailable'));
 // Values are stringified stably: nulls kept, trusted as numbers.
 assert.deepEqual(fullRead.entries.filmExternalId.find(([k])=>k===keyOf('film:tmdb:1','tmdb','1'))[1],'[1,0]');
}

// 4. The stable cut: the read takes the projector's lease, checks it at every page, and re-takes a content witness at every page boundary and at the end.
const leaseRow=file=>rows(file,"SELECT lease_id, started_at FROM projection_run WHERE projection='enrichment'")[0];
// A writer that does NOT hold the lease: it writes straight to the database from the stand-in's query hook, at the n-th query that matches `pattern`.
const intruder=(file,pattern,statement,nth=1)=>{let seen=0,fired=false;const standin=d1Standin(file,{onQuery:async text=>{if(!fired&&pattern.test(text)&&++seen===nth){fired=true;const r=sqlite(file,statement);assert.equal(r.status,0,r.stderr);}}});return readerOf(standin);};
{
 const quiet=await readAll(db(fixture),{pageSize:1000});
 assert.deepEqual([quiet.done,quiet.consistent,quiet.reasons],[true,true,[]]);
 assert.equal(leaseRow(fixture).lease_id,null,'the lease is released after the read');
 const paged=await readAll(db(fixture),{pageSize:1});
 assert.deepEqual([paged.consistent,paged.entries],[true,fullRead.entries],'a quiet read of one-row pages passes and reads the same set');
 assert.ok(paged.pages>20);
 // The lease is held WHILE the pages are read: a foreign acquire at the projector's own SQL cannot take it mid-read.
 {
  const file=database();seed(file);let observed=null;
  const standin=d1Standin(file,{onQuery:async text=>{if(/FROM watchlist_film/.test(text)&&observed===null){sqlite(file,"INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES ('enrichment','proj','2099-01-01T00:00:00.000Z','x') ON CONFLICT(projection) DO UPDATE SET lease_id=excluded.lease_id,lease_until=excluded.lease_until,started_at=excluded.started_at WHERE projection_run.lease_until IS NULL OR projection_run.lease_until<'2026-11-08T10:00:00.000Z'");observed=leaseRow(file).lease_id;}}});
  const read=await readAll(readerOf(standin),{pageSize:1000});
  assert.deepEqual([observed,read.consistent],['baseline:test',true],'the projector could not take the lease while we held it');
 }
 // (a) A foreign live lease already stands: nothing is read and the foreign row is untouched.
 {
  const file=database();seed(file);
  sqlite(file,"INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES ('enrichment','foreign','2099-01-01T00:00:00.000Z','2026-11-08T09:00:00.000Z') ON CONFLICT(projection) DO UPDATE SET lease_id='foreign',lease_until='2099-01-01T00:00:00.000Z',started_at='2026-11-08T09:00:00.000Z'");
  const refused=await readAll(db(file),{pageSize:1000});
  assert.deepEqual([refused.done,refused.consistent,refused.reasons,refused.entries],[false,false,['lease_unavailable'],undefined]);
  assert.deepEqual(leaseRow(file),{lease_id:'foreign',started_at:'2026-11-08T09:00:00.000Z'},'the foreign lease is not released or changed');
  // An expired foreign lease is taken, and the read goes ahead.
  sqlite(file,"UPDATE projection_run SET lease_until='2026-11-08T09:59:00.000Z'");
  assert.equal((await readAll(db(file),{pageSize:1000})).consistent,true);
 }
 // (b) An interleaved write by a writer without the lease, marker and baseline UNCHANGED, is caught by the witness: mid-class (page boundary), in a table already read,
 // in a table not yet read, and in an unread table whose count does not change (a flag flip).
 {
  const file=database();seed(file);
  const early=await readAll(intruder(file,/FROM film\b/,"UPDATE film SET updated_at='2026-11-08T10:05:00.000Z' WHERE id='film:tmdb:3'",2),{pageSize:1});
  assert.deepEqual([early.done,early.consistent,early.reasons],[false,false,['unstable_cut:film']],'caught at the page boundary of the class being read');
  assert.ok(early.pages<8,'the read stopped early, at the page boundary, not at the end');
  assert.equal(leaseRow(file).lease_id,null,'the lease is released after an aborted read');
 }
 for(const [label,pattern,statement,reason] of [
  ['a table already read','/FROM watchlist_film/',"UPDATE film SET updated_at='2026-11-08T10:06:00.000Z' WHERE id='film:tmdb:1'",'unstable_cut:film'],
  ['a flag flip with the same count','/FROM film_alias/',"UPDATE film_external_id SET trusted=0 WHERE film_id='film:tmdb:3'",'unstable_cut:filmExternalId'],
  ['an ordinal change','/FROM film_dimension/',"UPDATE film_person_credit SET ordinal=7 WHERE film_id='film:tmdb:2'",'unstable_cut:credit'],
  ['a new row','/FROM person_alias/',"INSERT INTO film_alias (film_id,kind,value) VALUES ('film:tmdb:3','title','Три')",'unstable_cut:filmAlias'],
  ['a deleted row','/FROM film_person_credit/',"DELETE FROM watchlist_film WHERE film_id='film:tmdb:2'",'unstable_cut:watchlist'],
  ['a projector key written','/FROM film_redirect/',"UPDATE projection_state SET projected_at='2026-11-08T10:07:00.000Z' WHERE id='film:tmdb:3'",'unstable_cut:projectionKey'],
  ['an owner-review write','/FROM watchlist_film/',"INSERT INTO owner_review_entry (kind,source_key,payload_json,identity_link,identity_state,generation) VALUES ('film','k','{}',NULL,'unlinked',1)",'unstable_cut:ownerLink'],
  ['a revision bump (a fenced writer)','/FROM watchlist_film/',"INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film','film:tmdb:1',1,'2026-11-08T10:00:00.000Z')",'unstable_cut:canonicalRevision'],
  ['a metadata write','/FROM film_dimension/',"INSERT INTO film_metadata (film_id,schema_version,genres_json,payload_json,updated_at) VALUES ('film:tmdb:1',1,'[]','{}','2026-11-08T10:00:00.000Z')",'unstable_cut:filmMetadata'],
 ]){
  const file=database();seed(file);
  const pattern2=new RegExp(pattern.slice(1,-1));
  const result=await readAll(intruder(file,pattern2,statement,2),{pageSize:1000});
  assert.deepEqual([result.consistent,result.reasons.includes(reason)],[false,true],label+': '+JSON.stringify(result.reasons));
  assert.equal(leaseRow(file).lease_id,null,label+': the lease is released');
 }
 // The writes are real: without an intruder the same read is consistent (the witness is not simply failing).
 // (c) A foreign lease taken AND released between two checks (the row ends free, or back with us under another start time) is detected at the next page.
 {
  const file=database();seed(file);
  const freed=await readAll(intruder(file,/FROM person\b/,"UPDATE projection_run SET lease_id='foreign',started_at='foreign-start';UPDATE projection_run SET lease_id=NULL,lease_until=NULL"),{pageSize:1000});
  assert.deepEqual([freed.consistent,freed.reasons],[false,['lease_lost']]);
  const file2=database();seed(file2);
  const swapped=await readAll(intruder(file2,/FROM person\b/,"UPDATE projection_run SET started_at='foreign-start'"),{pageSize:1000});
  assert.deepEqual([swapped.consistent,swapped.reasons],[false,['lease_lost']],'the same holder with another start time is not our lease');
 }
 // (c2) A lease lost only AFTER the last page (during the provenance check) is caught by the final check; the lease is renewed at every page.
 {
  const file=database();seed(file);
  const late=await readAll(intruder(file,/FROM person_alias WHERE person_id IN/,"UPDATE projection_run SET lease_id='foreign'"),{pageSize:1000});
  assert.deepEqual([late.consistent,late.reasons],[false,['lease_lost']]);
  const file2=database();seed(file2);
  let tick=0;const seen=[];
  const standin=d1Standin(file2,{onQuery:async()=>{const row=leaseRow(file2);if(row?.lease_id)seen.push(rows(file2,"SELECT lease_until FROM projection_run WHERE projection='enrichment'")[0].lease_until);}});
  const clock=()=>new Date(Date.parse(AT)+(tick++)*60000).toISOString();
  const quiet=await readStableCut(readerOf(standin),{leaseId:'baseline:test',now:clock,pageSize:2});
  assert.equal(quiet.consistent,true,JSON.stringify(quiet.reasons));
  assert.ok(new Set(seen).size>2&&seen.every((value,i)=>i===0||value>=seen[i-1]),'the lease_until moves forward as pages are read');
 }
 // (d) A lost lease aborts the read at once and its remaining pages are not read.
 {
  const file=database();seed(file);
  const lost=await readAll(intruder(file,/FROM person_external_id/,"UPDATE projection_run SET lease_id='foreign'"),{pageSize:1000});
  assert.deepEqual([lost.done,lost.consistent,lost.reasons],[false,false,['lease_lost']]);
  assert.ok(lost.pages<6);
  assert.equal(leaseRow(file).lease_id,'foreign','a foreign holder is not released by our finally');
 }
 // (e) The marker and the baseline row still invalidate the read (they are not witnessed tables).
 {
  const file=database();seed(file);
  const baseline=await readAll(intruder(file,/FROM watchlist_film/,"UPDATE film_person_baseline SET state='loading',reference='x' WHERE id=1"),{pageSize:1000});
  assert.deepEqual([baseline.consistent,baseline.reasons],[false,['baseline_changed']]);
  const file2=database();seed(file2);
  const moved=await readAll(intruder(file2,/FROM watchlist_film/,"UPDATE film_person_baseline SET state='loading',reference='x';UPDATE film_person_baseline SET state='verified';UPDATE film_person_authority SET mode='prepared',generation=1"),{pageSize:1000});
  assert.ok(moved.reasons.includes('marker_moved'));assert.equal(moved.consistent,false);
 }
 // (f) A page budget aborts the cut (it is never resumed across lease terms) and releases the lease.
 {
  const file=database();seed(file);
  const budget=await readAll(db(file),{pageSize:1,maxPages:3});
  assert.deepEqual([budget.done,budget.consistent,budget.reasons],[false,false,['budget_exceeded']]);
  assert.equal(leaseRow(file).lease_id,null);
 }
 // The witness: every compared table plus the revision table and the new tables; an optional table that is absent is null, not an error; it changes with the data.
 const witness=await readWitness(db(fixture));
 assert.ok(['film','credit','projectionKey','canonicalRevision','filmLocalizationSource','personLocalizationSource','filmMetadata','retention','ratedAdmission','retirement'].every(name=>name in witness));
 const old=database({upTo:chain.findIndex(name=>name.startsWith('0016_'))});
 assert.equal((await readWitness(db(old))).retirement,null);
 const legacy=database({upTo:chain.findIndex(name=>name.startsWith('0013_'))});
 assert.equal((await readWitness(db(legacy))).canonicalRevision,null);
 assert.ok((await readAll(db(legacy),{pageSize:1000})).reasons.includes('marker_unreadable'),'a schema below 13 has no marker to read');
 const gate=await readGate(db(fixture),{now:AT});
 assert.deepEqual([gate.marker,gate.baseline.state,gate.lease.live],[{mode:'r2',cutover:'open',generation:0},'empty',false]);
 assert.equal((await readGate(db(legacy),{now:AT})).marker,null);
 await assert.rejects(()=>readStableCut(db(fixture),{}),code('baseline_invalid'));
}

// 5. The expected side derived from the actual side with perturbations: the plan, the explanations from context, and the sample verification.
const actualSide={classes:toClasses(fullRead.entries),unavailable:fullRead.unavailable,complete:true,consistent:true};
const context=contextFromActual(actualSide,{air286:fullRead.air286.verified});
{
 assert.deepEqual(fullRead.air286.verified,['person:tmdb_actor/9'],'the one unkeyed Person has verified AIR-286 provenance');
 assert.deepEqual([...context.explainedPersons],['person:tmdb_actor/9']);
 assert.deepEqual([...context.unkeyedPersons],['person:tmdb_actor/9'],'the one Person without a projector key');
 assert.deepEqual([...context.retainedFilms].sort(),['film:retained']);
 const expected=cloneSide(actualSide);
 // The R2-derived view lacks the D1-only credit and the D1-only Person (explained), the retained Film (explained), and differs from D1 on one Film and lacks one Film's alias.
 const strip=(name,pred)=>{expected.classes[name]=expected.classes[name].filter(entry=>!pred(entry[0]));};
 strip('credit',key=>key.includes('person:tmdb_actor/9'));strip('person',key=>key==='person:tmdb_actor/9');strip('personAlias',key=>key.startsWith('person:tmdb_actor/9'));
 for(const name of ['film','filmExternalId','filmAlias','credit','filmLocalization'])strip(name,key=>key.startsWith('film:retained'));
 const baseline=await buildParityLedger({expected:{...expected,source:SOURCE},actual:actualSide,context});
 assert.equal(baseline.ledger.totals.unexplained,0,JSON.stringify(baseline.ledger.unexplainedList));
 assert.ok(baseline.ledger.totals.explained>=5);
 // Sample verification: the owner localization equals; a different value is an unexplained difference that no default rule explains.
 const ownerKey='film:tmdb:1';
 assert.equal(actualSide.classes.filmLocalization.find(([k])=>k===ownerKey)[1].includes('owner'),true);
 const ownerDiff=cloneSide(actualSide);ownerDiff.classes.filmLocalization=ownerDiff.classes.filmLocalization.map(([k,v])=>k===ownerKey?[k,v.replace('Владелец','Другое')]:[k,v]);
 const ownerStrip=JSON.parse(JSON.stringify(expected));ownerStrip.classes.filmLocalization=ownerDiff.classes.filmLocalization;
 const diffOwner=await buildParityLedger({expected:{...ownerStrip,source:SOURCE},actual:actualSide,context});
 assert.deepEqual(diffOwner.diffs,[{class:'filmLocalization',side:'differs',key:ownerKey}],'a differing owner value is never explained');
 // The plan: missing and differing entities become units; extras and decision classes are listed for the owner, never applied.
 const wanted=cloneSide(actualSide);
 wanted.classes.film.push(['film:new:1','["new"]'],['film:new:2','["new"]']);
 wanted.classes.person.push(...Array.from({length:60},(_,i)=>['person:new/'+String(i).padStart(3,'0'),'["x"]']));
 wanted.classes.filmAlias=wanted.classes.filmAlias.map(([k,v])=>k.startsWith('film:tmdb:2')?[k,v+'x']:[k,v]);
 wanted.classes.redirect.push(['film:gone','film:tmdb:1']);
 wanted.classes.film=wanted.classes.film.filter(([k])=>k!=='film:tmdb:3');
 const built=await buildParityLedger({expected:{...wanted,source:SOURCE},actual:actualSide,context:{...context,retainedFilms:new Set()}});
 const plan=await planReconciliation({diffs:built.diffs,actual:actualSide,ledgerDigest:built.ledger.digest,unitPeople:25});
 assert.deepEqual(plan.units.filter(u=>u.kind==='film').map(u=>u.ids[0]),['film:new:1','film:new:2','film:tmdb:2']);
 assert.deepEqual(plan.units.filter(u=>u.kind==='people').map(u=>u.ids.length),[25,25,10]);
 assert.equal(plan.manualCount,1,'the redirect is for the owner');
 assert.ok(plan.extraCount>=1,'film:tmdb:3 is extra on D1 and the projector would release it: not applied by the importer');
 assert.ok(plan.units.every(u=>/^[0-9a-f]{16}$/.test(u.id)&&/^[0-9a-f]{64}$/.test(u.d1Digest)));
 const again=await planReconciliation({diffs:built.diffs,actual:actualSide,ledgerDigest:built.ledger.digest,unitPeople:25});
 assert.equal(again.digest,plan.digest,'the plan is deterministic');
 // The unit's D1 digest follows the D1 rows it was planned against.
 const tmdb2=plan.units.find(u=>u.ids[0]==='film:tmdb:2');
 const moved=JSON.parse(JSON.stringify(actualSide));moved.classes.filmAlias.push([keyOf('film:tmdb:2','title','Новый'),'null']);
 const replan=await planReconciliation({diffs:built.diffs,actual:moved,ledgerDigest:built.ledger.digest,unitPeople:25});
 assert.notEqual(replan.units.find(u=>u.ids[0]==='film:tmdb:2').d1Digest,tmdb2.d1Digest);
 assert.equal(replan.units.find(u=>u.ids[0]==='film:new:1').d1Digest,plan.units.find(u=>u.ids[0]==='film:new:1').d1Digest);
 globalThis.__plan=plan;
}

// 5b. REAL end-to-end convergence: expectedFromInputs -> a sqlite D1 stand-in seeded with the corresponding rows (by explicit SQL, not by the module's mapping) -> a stable cut
// -> the ledger: zero differences and zero unexplained; then one mutated row per class makes exactly that class report.
const e2eInputs={
 films:[
  {id:'film:tmdb:10',film:{contractVersion:1,canonicalIdentity:'ident-10',originalTitle:'Ten',externalIds:[{scheme:'tmdb',value:'10',trusted:true,conflicting:false},{scheme:'letterboxd',value:'ten',trusted:true}],aliases:[{kind:'title',value:'Десять'}],localization:{status:'reviewed',value:'Владелец10',provenance:{authority:'owner'}},redirects:[{from:'film:old:10',to:'film:tmdb:10'}]},watchlist:true,credits:[{personId:'person:director/10',role:'director',ordinal:0},{personId:'person:actor/11',role:'actor',ordinal:0},{personId:'person:actor/12',role:'actor',ordinal:1}]},
  {id:'film:tmdb:20',film:{contractVersion:1,originalTitle:'Twenty',externalIds:[{scheme:'tmdb',value:'20',trusted:true}],aliases:[],localization:{status:'provisional',value:'Двадцать',provenance:{}}},watchlist:false,credits:[]},
 ],
 people:[
  {id:'person:director/10',person:{roleId:'director/10',externalIds:[{scheme:'letterboxd',value:'d10',trusted:true}],aliases:[{kind:'name',value:'Режиссёр'}],localization:{status:'reviewed',value:'Режиссёр10',provenance:{}}}},
  {id:'person:actor/11',person:{roleId:'actor/11',externalIds:[],aliases:[{kind:'name',value:'Актёр'}],localization:{status:'provisional',value:'Актёр11'}}},
  {id:'person:actor/12',person:{roleId:'actor/12',externalIds:[],aliases:[],localization:{status:'missing'}}},
 ],
};
const e2eExtras={
 retirement:[['film:abc1',['retire','5','6']]],
 ratedAdmission:[['film:tmdb:20',['20','srcA','a'.repeat(64)]]],
 retention:[['film:tmdb:20',[0]]],
 ownerLink:[[keyOf('film','k1'),['film:tmdb:10','verified']]],
 projectionKey:[[keyOf('film','film:tmdb:10'),['ck1']],[keyOf('film','film:tmdb:20'),['ck2']],[keyOf('person','person:director/10'),['pk1']],[keyOf('person','person:actor/11'),['pk2']],[keyOf('person','person:actor/12'),['pk3']]],
};
function seedE2e(file){
 const T="'"+AT+"'";
 const statements=[
  `INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:10',1,'ident-10','Ten',${T}),('film:tmdb:20',1,NULL,'Twenty',${T})`,
  `INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:director/10','director/10',1,${T}),('person:actor/11','actor/11',1,${T}),('person:actor/12','actor/12',1,${T})`,
  "INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:tmdb:10','tmdb','10',1,0),('film:tmdb:10','letterboxd','ten',1,0),('film:tmdb:20','tmdb','20',1,0)",
  "INSERT INTO person_external_id (person_id,scheme,value,trusted,conflicting) VALUES ('person:director/10','letterboxd','d10',1,0)",
  "INSERT INTO film_alias (film_id,kind,value) VALUES ('film:tmdb:10','title','Десять')",
  "INSERT INTO person_alias (person_id,kind,value) VALUES ('person:director/10','name','Режиссёр'),('person:actor/11','name','Актёр')",
  "INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:old:10','film:tmdb:10','2026-11-01T00:00:00.000Z')",
  "INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES ('film:tmdb:10','person:director/10','director',0),('film:tmdb:10','person:actor/11','actor',0),('film:tmdb:10','person:actor/12','actor',1)",
  `INSERT INTO film_dimension (film_id,dimension,status,source,provenance_json,value,authority,attempts,updated_at) VALUES ('film:tmdb:10','localization','reviewed','owner','{}','Владелец10','owner',0,${T}),('film:tmdb:20','localization','provisional','wikidata','{}','Двадцать',NULL,0,${T})`,
  `INSERT INTO person_dimension (person_id,dimension,status,source,provenance_json,value,authority,attempts,updated_at) VALUES ('person:director/10','localization','reviewed','dictionary','{}','Режиссёр10',NULL,0,${T}),('person:actor/11','localization','provisional','wikidata','{}','Актёр11',NULL,0,${T}),('person:actor/12','localization','missing',NULL,'{}',NULL,NULL,0,${T})`,
  `INSERT INTO watchlist_film (film_id,updated_at) VALUES ('film:tmdb:10',${T})`,
  `INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('film:tmdb:20','20','srcA','${'a'.repeat(64)}','T',2000,'k','tmdb_20','2026-11-01T00:00:00.000Z','r1',${T})`,
  `INSERT INTO film_retention (film_id,basis,watchlist,evidence_json,request_id,observed_at,updated_at) VALUES ('film:tmdb:20','watchlist_fact',0,'{}','r2','2026-11-01T00:00:00.000Z',${T})`,
  `INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,payload_json,recorded_at) VALUES ('d1','film:abc1','retire','abc1','5','6','{}','{"by":"owner","at":"t","source":"s"}','owner_request','{}',${T})`,
  "INSERT INTO owner_review_entry (kind,source_key,payload_json,identity_link,identity_state,generation) VALUES ('film','k1','{}','film:tmdb:10','verified',1)",
  `INSERT INTO projection_state (projection,kind,id,change_key,projected_at) VALUES ('enrichment','film','film:tmdb:10','ck1',${T}),('enrichment','film','film:tmdb:20','ck2',${T}),('enrichment','person','person:director/10','pk1',${T}),('enrichment','person','person:actor/11','pk2',${T}),('enrichment','person','person:actor/12','pk3',${T})`,
 ];
 const result=sqlite(file,statements.join(';\n'));
 assert.equal(result.status,0,result.stderr);
}
const e2eLedger=async file=>{
 const cut=await readAll(db(file),{pageSize:2});
 assert.equal(cut.consistent,true,JSON.stringify(cut.reasons));
 const expected={classes:expectedFromInputs(e2eInputs,e2eExtras),complete:true,source:SOURCE};
 return buildParityLedger({expected,actual:{classes:cut.entries,unavailable:cut.unavailable,complete:true,consistent:true},context:contextFromActual({classes:cut.entries},{air286:cut.air286.verified})});
};
{
 const file=database();seedE2e(file);
 const {ledger,diffs}=await e2eLedger(file);
 assert.deepEqual([ledger.totals.missing,ledger.totals.extra,ledger.totals.differs,ledger.totals.explained,ledger.totals.unexplained,diffs.length],[0,0,0,0,0,0],JSON.stringify(ledger.unexplainedList));
 assert.equal(ledger.complete,true);
 for(const item of CLASSES){const c=ledger.classes[item.name];assert.equal(c.expected.digest,c.actual.digest,item.name);assert.ok(c.expected.count>0,item.name+' is exercised');}
 // One mutated row per class: exactly that class reports, 'differs' for a class with a value column.
 const retireRestore="INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,supersedes_seq,payload_json,recorded_at) VALUES ('d2','film:abc1','restore','abc1','5','6','{\"reason\":\"r\"}','{\"by\":\"owner\",\"at\":\"t\",\"source\":\"s\"}','owner_request',1,'{}','"+AT+"')";
 const mutations=[
  ['film',"UPDATE film SET original_title='Ten!' WHERE id='film:tmdb:10'",'differs'],
  ['person',"UPDATE person SET role_id='director/99' WHERE id='person:director/10'",'differs'],
  ['filmExternalId',"UPDATE film_external_id SET trusted=0 WHERE film_id='film:tmdb:10' AND scheme='tmdb'",'differs'],
  ['personExternalId',"UPDATE person_external_id SET trusted=0 WHERE person_id='person:director/10'",'differs'],
  ['filmAlias',"UPDATE film_alias SET value='Другой' WHERE film_id='film:tmdb:10'",'both'],
  ['personAlias',"UPDATE person_alias SET value='Другое' WHERE person_id='person:actor/11'",'both'],
  ['credit',"UPDATE film_person_credit SET ordinal=5 WHERE person_id='person:actor/12'",'differs'],
  ['filmLocalization',"UPDATE film_dimension SET value='Другое' WHERE film_id='film:tmdb:10' AND dimension='localization'",'differs'],
  ['personLocalization',"UPDATE person_dimension SET value='Другое' WHERE person_id='person:director/10' AND dimension='localization'",'differs'],
  ['watchlist',"DELETE FROM watchlist_film WHERE film_id='film:tmdb:10'",'missing'],
  ['redirect',"UPDATE film_redirect SET to_film_id='film:tmdb:20' WHERE from_id='film:old:10'",'differs'],
  ['retirement',retireRestore,'differs'],
  ['ratedAdmission',"UPDATE film_rated_admission SET source_code='srcB' WHERE film_id='film:tmdb:20'",'differs'],
  ['retention',"UPDATE film_retention SET watchlist=1 WHERE film_id='film:tmdb:20'",'differs'],
  ['ownerLink',"UPDATE owner_review_entry SET identity_state='held' WHERE source_key='k1'",'differs'],
  ['projectionKey',"UPDATE projection_state SET change_key='zz' WHERE id='film:tmdb:10'",'differs'],
 ];
 assert.deepEqual(mutations.map(item=>item[0]).sort(),CLASSES.map(item=>item.name).sort(),'every class has a mutation');
 for(const [name,statement,kind] of mutations){
  const mutated=database();seedE2e(mutated);
  const r=sqlite(mutated,statement);assert.equal(r.status,0,name+': '+r.stderr);
  const {ledger:l}=await e2eLedger(mutated);
  for(const item of CLASSES){
   const c=l.classes[item.name],differences=c.missing+c.extra+c.differs;
   if(item.name!==name){assert.equal(differences,0,name+' leaked into '+item.name);continue;}
   assert.ok(differences>0,name+' is reported');
   if(kind==='differs')assert.deepEqual([c.differs,c.missing,c.extra],[1,0,0],name);
   if(kind==='missing')assert.deepEqual([c.missing,c.extra,c.differs],[1,0,0],name);
   if(kind==='both')assert.deepEqual([c.missing,c.extra,c.differs],[1,1,0],name);
  }
  assert.equal(l.totals.unexplained,l.totals.missing+l.totals.extra+l.totals.differs,name+': nothing is explained away');
 }
}

// 5c. A Person without a projector key is explained only by VERIFIED AIR-286 provenance or an owner exception; never by being unkeyed.
{
 const file=database();seed(file);
 const T="'"+AT+"'";
 const add=sqlite(file,[
  `INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:actor/77','actor/77',1,${T}),('person:tmdb_actor/55','tmdb_actor/55',1,${T}),('person:tmdb_actor/56','tmdb_actor/56',1,${T}),('person:tmdb_director/57','tmdb_director/57',1,${T}),('person:tmdb_actor/58','tmdb_actor/58',1,${T}),('person:tmdb_actor/59','tmdb_actor/59',1,${T}),('person:tmdb_actor/60','tmdb_actor/60',2,${T}),('person:tmdb_actor/61','tmdb_actor/61',1,${T}),('person:tmdb_actor/62','tmdb_actor/62',1,${T}),('person:tmdb_actor/65','tmdb_actor/65',1,${T})`,
  "INSERT INTO person_alias (person_id,kind,value,provenance_json) VALUES ('person:tmdb_actor/55','name','a','"+AIR286+"'),('person:tmdb_actor/56','name','b',NULL),('person:tmdb_director/57','name','c','"+AIR286+"'),('person:tmdb_actor/58','name','d','"+AIR286+"'),('person:tmdb_actor/60','name','e','"+AIR286+"'),('person:tmdb_actor/61','title','f','"+AIR286+"'),('person:tmdb_actor/61','name','g','"+AIR286+"'),('person:tmdb_actor/62','name','h','{\"source\":\"tmdb\",\"task\":\"AIR-999\"}')",
  "INSERT INTO person_external_id (person_id,scheme,value,trusted,conflicting) VALUES ('person:tmdb_actor/58','letterboxd','x',1,0)",
  `INSERT INTO person_dimension (person_id,dimension,status,source,provenance_json,attempts,updated_at) VALUES ('person:tmdb_actor/59','identity','resolved','x','{}',0,${T})`,
  "INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES ('film:tmdb:1','person:actor/77','actor',5),('film:tmdb:3','person:tmdb_actor/55','actor',0),('film:tmdb:1','person:tmdb_actor/56','actor',6),('film:tmdb:1','person:tmdb_director/57','actor',7),('film:tmdb:1','person:tmdb_actor/58','actor',8),('film:tmdb:1','person:tmdb_actor/60','actor',9),('film:tmdb:1','person:tmdb_actor/61','actor',10),('film:tmdb:1','person:tmdb_actor/62','actor',11),('film:tmdb:1','person:tmdb_actor/65','actor',12)",
 ].join(';\n'));
 assert.equal(add.status,0,add.stderr);
 const cut=await readAll(db(file),{pageSize:1000});
 assert.equal(cut.consistent,true);
 const rejected=Object.fromEntries(cut.air286.rejected.map(item=>[item.id,item.reasons]));
 assert.deepEqual(cut.air286.verified,['person:tmdb_actor/9'],'only the verified AIR-286 Person is verified');
 assert.ok(rejected['person:actor/77'].includes('id_shape'),'wrong id shape');
 assert.ok(rejected['person:tmdb_actor/55'].includes('credit_film'),'a credit on a Film that is neither a watchlist Film nor a member');
 assert.ok(rejected['person:tmdb_actor/56'].includes('alias_provenance'),'an alias without the AIR-286 provenance');
 assert.ok(rejected['person:tmdb_director/57'].includes('credit_role'),'a credit in another role than its id');
 assert.ok(rejected['person:tmdb_actor/58'].includes('external_ids'));
 assert.ok(rejected['person:tmdb_actor/59'].includes('dimensions'));
 assert.ok(rejected['person:tmdb_actor/60'].includes('contract_version'));
 assert.ok(rejected['person:tmdb_actor/61'].includes('alias_count')&&rejected['person:tmdb_actor/61'].includes('alias_kind'));
 assert.ok(rejected['person:tmdb_actor/62'].includes('alias_provenance'),'another task is not AIR-286');
 assert.deepEqual(rejected['person:tmdb_actor/65'],['alias_missing'],'an unnamed Person (right id, role, version, watchlist credit) has no automatic proof');
 // A Person with no credit at all is rejected, and a missing row cannot be verified.
 {
  const seeded=sqlite(file,`INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:tmdb_actor/64','tmdb_actor/99',1,${T});INSERT INTO person_alias (person_id,kind,value,provenance_json) VALUES ('person:tmdb_actor/64','name','z','${AIR286}');INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES ('film:tmdb:1','person:tmdb_actor/64','actor',20)`);
  assert.equal(seeded.status,0,seeded.stderr);
  const wrong=await verifyAir286(db(file),['person:tmdb_actor/64']);
  assert.deepEqual(wrong.rejected,[{id:'person:tmdb_actor/64',reasons:['role_id']}],'a valid-looking Person with a foreign role_id is rejected');
 }
 const none=sqlite(file,`INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:tmdb_actor/63','tmdb_actor/63',1,${T})`);assert.equal(none.status,0,none.stderr);
 const direct=await verifyAir286(db(file),['person:tmdb_actor/63','person:tmdb_actor/404','person:tmdb_actor/9']);
 assert.deepEqual(direct.verified,['person:tmdb_actor/9']);
 assert.deepEqual(direct.rejected.map(item=>[item.id,item.reasons.includes('no_credit')||item.reasons.includes('no_person_row')]),[['person:tmdb_actor/404',true],['person:tmdb_actor/63',true]]);
 // The ledger: the expected side lacks every unkeyed Person (the view does not carry them). Only the verified one is explained; the rest keeps the gate closed.
 const unkeyed=new Set(['person:tmdb_actor/65','person:actor/77','person:tmdb_actor/9','person:tmdb_actor/55','person:tmdb_actor/56','person:tmdb_director/57','person:tmdb_actor/58','person:tmdb_actor/60','person:tmdb_actor/61','person:tmdb_actor/62']);
 const expectedWithout=()=>{
  const classes=JSON.parse(JSON.stringify(cut.entries));
  classes.person=classes.person.filter(([k])=>!unkeyed.has(k));
  for(const name of ['personExternalId','personAlias','personLocalization'])classes[name]=classes[name].filter(([k])=>!unkeyed.has(k.split('\u001f')[0]));
  classes.credit=classes.credit.filter(([k])=>!unkeyed.has(k.split('\u001f')[1]));
  return {classes,complete:true,source:SOURCE};
 };
 const ledgerOf=async options=>buildParityLedger({expected:expectedWithout(),actual:{classes:cut.entries,complete:true,consistent:true,unavailable:cut.unavailable},context:contextFromActual({classes:cut.entries},{air286:cut.air286.verified,...options})});
 const base=await ledgerOf({});
 const rest=base.diffs.map(item=>item.class+':'+item.key.split('\u001f').slice(0,2).join('|'));
 assert.ok(base.ledger.totals.unexplained>0&&!rest.some(item=>item.includes('person:tmdb_actor/9')),'the verified Person and its rows are explained, nothing else is: '+rest.join(','));
 assert.ok(base.diffs.some(item=>item.class==='person'&&item.key==='person:actor/77'),'a non-AIR-286 unkeyed Person is unexplained');
 assert.ok(base.diffs.some(item=>item.class==='credit'&&item.key.includes('person:tmdb_actor/55')),'a credit on a non-watchlist Film is unexplained even for a tmdb id');
 assert.ok(base.diffs.some(item=>item.class==='credit'&&item.key.includes('person:tmdb_director/57')),'a credit in the wrong role is unexplained');
 assert.equal((await baselineGate(base.ledger)).pass,false,'the gate stays closed');
 assert.ok(base.diffs.some(item=>item.class==='person'&&item.key==='person:tmdb_actor/65'),'an alias-less Person is unexplained although id, role, version and credit look right');
 {
  // Only the alias-less Person is left unexplained: its own exception explains exactly it, and the gate then depends on nothing else about it.
  const only=await ledgerOf({personExceptions:[{id:'person:tmdb_actor/65',reason:'unnamed AIR-286 Person, owner checked',approvedBy:'owner'}]});
  assert.ok(!only.diffs.some(item=>item.key.includes('person:tmdb_actor/65')),'the exception explains the listed id');
  assert.ok(only.diffs.some(item=>item.class==='person'&&item.key==='person:actor/77')&&only.diffs.some(item=>item.class==='person'&&item.key==='person:tmdb_actor/56'),'no other Person is explained');
 }
 // An owner exception explains exactly the listed id and its own rows, nothing else.
 const excepted=await ledgerOf({personExceptions:[{id:'person:actor/77',reason:'owner reviewed: a manual import',approvedBy:'owner'},{id:'person:director/1',reason:'a keyed Person',approvedBy:'owner'},{id:'person:ghost',reason:'not in D1',approvedBy:'owner'},{id:'person:tmdb_actor/56',reason:'',approvedBy:'owner'},{id:'person:tmdb_actor/55',reason:'x'}]});
 const left=excepted.diffs.map(item=>item.key.split('\u001f').slice(0,2).join('|'));
 assert.ok(!left.some(item=>item.includes('person:actor/77')),'the listed id and its credit are explained');
 assert.ok(left.some(item=>item.includes('person:tmdb_actor/56'))&&left.some(item=>item.includes('person:tmdb_actor/55')),'an exception without a reason or an approver explains nothing');
 assert.ok(left.some(item=>item.includes('person:tmdb_director/57')),'no other id is explained');
 assert.equal(excepted.ledger.totals.unexplained,base.ledger.totals.unexplained-excepted.ledger.totals.explained+base.ledger.totals.explained,'the exception only moved its own rows');
 // The explanation never covers unmatched CHILD rows of other Persons: extra rows on a KEYED Person stay unexplained although an excepted and a verified Person exist.
 const keyedChild=JSON.parse(JSON.stringify(cut.entries));
 keyedChild.personAlias.push([keyOf('person:director/1','name','Лишний'),'[]']);
 keyedChild.personExternalId.push([keyOf('person:director/1','tmdb','1'),'[1,0]']);
 keyedChild.credit.push([keyOf('film:tmdb:2','person:actor/3','actor'),'[9]']);
 const child=await buildParityLedger({expected:expectedWithout(),actual:{classes:keyedChild,complete:true,consistent:true,unavailable:cut.unavailable},context:contextFromActual({classes:keyedChild},{air286:cut.air286.verified,personExceptions:[{id:'person:actor/77',reason:'manual',approvedBy:'owner'}]})});
 const childKeys=child.diffs.map(item=>item.class+':'+item.key.split('\u001f')[0]+(item.class==='credit'?'|'+item.key.split('\u001f')[1]:''));
 assert.ok(childKeys.includes('personAlias:person:director/1')&&childKeys.includes('personExternalId:person:director/1')&&childKeys.includes('credit:film:tmdb:2|person:actor/3'),'child rows of other Persons stay unexplained: '+childKeys.join(','));
 // A verified Person whose TMDB credit sits on a non-watchlist Film: the credit is not explained by the Person's verification.
 const moved=JSON.parse(JSON.stringify(cut.entries));
 moved.credit.push([keyOf('film:tmdb:3','person:tmdb_actor/9','actor'),'[3]']);
 const offList=await buildParityLedger({expected:expectedWithout(),actual:{classes:moved,complete:true,consistent:true,unavailable:cut.unavailable},context:contextFromActual({classes:moved},{air286:cut.air286.verified})});
 assert.ok(offList.diffs.some(item=>item.class==='credit'&&item.key.includes('film:tmdb:3')&&item.key.includes('person:tmdb_actor/9')));
 // An air286 id list can only explain an unkeyed Person: a keyed or absent id in it is ignored.
 const ctx=contextFromActual({classes:cut.entries},{air286:['person:director/1','person:ghost','person:tmdb_actor/9']});
 assert.deepEqual([...ctx.explainedPersons],['person:tmdb_actor/9']);
 const keyedException=contextFromActual({classes:cut.entries},{personExceptions:[{id:'person:director/1',reason:'r',approvedBy:'owner'},{id:'person:ghost',reason:'r',approvedBy:'owner'}]});
 assert.equal(keyedException.explainedPersons.size,0,'an exception explains only an existing unkeyed Person');
 const noNeed=contextFromActual({classes:cut.entries},{});
 assert.equal(noNeed.explainedPersons.size,0,'an unkeyed Person is not explained by being unkeyed');
}

// 6. The importer driver with an injected writer: checkpoint, resume at every point, unknown outcomes, a concurrent writer, gate and lease mismatch, idempotent re-run.
{
 const plan=globalThis.__plan;
 const makeWorld=()=>{
  const world={applied:new Set(),applyCalls:[],digestOverride:new Map(),leaseReleased:0,leaseTaken:0,applyFails:new Map(),commitThenThrow:new Set(),readbackOverride:null};
  world.writer={
   acquire:async()=>{world.leaseTaken++;return {leaseId:'lease-1'};},
   release:async()=>{world.leaseReleased++;},
   currentDigest:async unit=>world.digestOverride.get(unit.id)??unit.d1Digest,
   apply:async unit=>{
    world.applyCalls.push(unit.id);
    const fail=world.applyFails.get(unit.id);
    if(fail&&fail.times>0){fail.times--;throw fail.error;}
    if(world.commitThenThrow.has(unit.id)){world.applied.add(unit.id);world.commitThenThrow.delete(unit.id);throw new Error('D1_ERROR: network lost');}
    world.applied.add(unit.id);
   },
   readback:async unit=>world.readbackOverride?{state:world.readbackOverride}:{state:world.applied.has(unit.id)?'applied':'not_applied'},
  };
  return world;
 };
 const okGate=async()=>({ok:true});
 const store=()=>{const saves=[];return {saves,save:async state=>{saves.push(JSON.parse(JSON.stringify(state)));}};};
 // A complete run: every unit applied once, the lease taken once and released, the checkpoint saved before and after every unit.
 {
  const world=makeWorld(),s=store();
  const result=await runImport({plan,writer:world.writer,save:s.save,gate:okGate});
  assert.deepEqual([result.complete,result.remaining,world.applyCalls.length,world.leaseTaken,world.leaseReleased],[true,0,plan.units.length,1,1]);
  assert.equal(new Set(world.applyCalls).size,plan.units.length);
  assert.equal(s.saves.length,plan.units.length*2,'in flight before, done after');
  assert.ok(s.saves.every((state,i)=>i%2===0?state.inFlight!==null:state.inFlight===null));
  // Idempotent re-run with the final checkpoint: nothing is applied again.
  const again=await runImport({plan,checkpoint:s.saves.at(-1),writer:world.writer,save:s.save,gate:okGate});
  assert.deepEqual([again.complete,world.applyCalls.length],[true,plan.units.length]);
  await assert.rejects(()=>runImport({plan:{...plan,digest:'0'.repeat(64)},checkpoint:s.saves.at(-1),writer:world.writer,save:s.save,gate:okGate}),code('baseline_plan_changed'));
 }
 // A crash at EVERY save point: the resumed run converges, and a unit that was applied before the crash is settled by readback and never applied twice.
 {
  const total=plan.units.length*2;
  for(let crashAt=1;crashAt<=total;crashAt++){
   const world=makeWorld(),saved=[];
   let calls=0;
   const crashing=async state=>{calls++;if(calls===crashAt)throw new Error('CRASH');saved.push(JSON.parse(JSON.stringify(state)));};
   await assert.rejects(()=>runImport({plan,writer:world.writer,save:crashing,gate:okGate}),/CRASH/);
   assert.equal(world.leaseReleased,1,'the lease is released after a crash');
   const resume=await runImport({plan,checkpoint:saved.at(-1)??null,writer:world.writer,save:async state=>{saved.push(JSON.parse(JSON.stringify(state)));},gate:okGate});
   assert.equal(resume.complete,true,'crash at save '+crashAt);
   assert.equal(world.applied.size,plan.units.length);
   const counts=new Map();for(const id of world.applyCalls)counts.set(id,(counts.get(id)||0)+1);
   assert.ok([...counts.values()].every(c=>c===1),'no unit is applied twice (crash at save '+crashAt+')');
  }
 }
 // Unknown outcomes: committed but the answer lost (readback settles it, no re-apply); not committed (one safe re-apply after readback); persistently failing; readback unknown.
 {
  const [u0,u1,u2]=plan.units;
  const world=makeWorld(),s=store();
  world.commitThenThrow.add(u0.id);
  assert.equal((await runImport({plan,writer:world.writer,save:s.save,gate:okGate,maxUnits:1})).complete,false);
  assert.deepEqual(world.applyCalls,[u0.id],'committed-but-lost is settled by readback, not re-applied');
  assert.ok(world.applied.has(u0.id));
  const w2=makeWorld();
  w2.applyFails.set(u1.id,{times:1,error:new Error('D1_ERROR: network')});
  assert.equal((await runImport({plan,writer:w2.writer,save:store().save,gate:okGate})).complete,true);
  assert.equal(w2.applyCalls.filter(id=>id===u1.id).length,2,'one re-apply, only after the readback said not applied');
  const w3=makeWorld();
  w3.applyFails.set(u1.id,{times:5,error:new Error('D1_ERROR: network')});
  const failed=await runImport({plan,writer:w3.writer,save:store().save,gate:okGate});
  assert.deepEqual([failed.stopped,failed.unit,failed.complete],['unit_failed',u1.id,false]);
  assert.equal(w3.applyCalls.filter(id=>id===u1.id).length,2,'never more than one retry');
  assert.ok(!w3.applyCalls.includes(u2.id),'nothing after a failed unit runs');
  const w4=makeWorld();
  w4.applyFails.set(u0.id,{times:5,error:new Error('D1_ERROR: network')});w4.readbackOverride='unknown';
  const unknown=await runImport({plan,writer:w4.writer,save:store().save,gate:okGate});
  assert.deepEqual([unknown.stopped,w4.applyCalls.length],['unknown_outcome',1],'an unknown readback stops the run without a blind retry');
  // Resuming from an in-flight state with an unknown readback stays stopped.
  const w5=makeWorld();w5.readbackOverride='unknown';
  const stuck=await runImport({plan,checkpoint:{version:1,planDigest:plan.digest,done:[],stale:[],inFlight:{unitId:u0.id,attempt:1},applied:0},writer:w5.writer,save:store().save,gate:okGate});
  assert.deepEqual([stuck.stopped,w5.applyCalls.length],['unknown_outcome',0]);
 }
 // A concurrent writer: a unit whose D1 rows changed since the plan is skipped as stale, the rest proceed, and the run is not complete.
 {
  const world=makeWorld(),s=store();
  const target=plan.units[1];world.digestOverride.set(target.id,'f'.repeat(64));
  const result=await runImport({plan,writer:world.writer,save:s.save,gate:okGate});
  assert.deepEqual([result.complete,result.state.stale,world.applyCalls.includes(target.id),world.applyCalls.length],[false,[target.id],false,plan.units.length-1]);
 }
 // Generation, marker and lease mismatch: the gate stops the run before any apply; a lost lease stops it and leaves the unit in flight for readback.
 {
  const world=makeWorld();
  const stopped=await runImport({plan,writer:world.writer,save:store().save,gate:async()=>({ok:false,reason:'marker_generation_moved'})});
  assert.deepEqual([stopped.stopped,stopped.reason,world.applyCalls.length,world.leaseReleased],['gate_moved','marker_generation_moved',0,1]);
  const w2=makeWorld();let calls=0;
  const lateGate=async()=>(++calls>2?{ok:false,reason:'lease_not_ours'}:{ok:true});
  const late=await runImport({plan,writer:w2.writer,save:store().save,gate:lateGate});
  assert.deepEqual([late.stopped,w2.applyCalls.length],['gate_moved',2]);
  const w3=makeWorld(),s3=store();
  w3.applyFails.set(plan.units[0].id,{times:1,error:new Error('CHECK constraint failed: film_person_cas')});
  const lost=await runImport({plan,writer:w3.writer,save:s3.save,gate:okGate});
  assert.deepEqual([lost.stopped,lost.unit,w3.applyCalls.length],['lease_lost',plan.units[0].id,1],'no retry after a lost lease');
  assert.equal(lost.state.inFlight.unitId,plan.units[0].id);
  const none=makeWorld();none.writer.acquire=async()=>null;
  await assert.rejects(()=>runImport({plan,writer:none.writer,save:store().save,gate:okGate}),code('baseline_lease_unavailable'));
  await assert.rejects(()=>runImport({plan:null,writer:world.writer,save:store().save,gate:okGate}),code('baseline_plan_invalid'));
 }
 // makeGate on the stand-in: ok only while the marker is r2/open at the expected generation and the lease is ours and live.
 {
  const file=database();
  sqlite(file,"INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES ('enrichment','mine','2099-01-01T00:00:00.000Z','2026-11-08T09:00:00.000Z') ON CONFLICT(projection) DO UPDATE SET lease_id='mine',lease_until='2099-01-01T00:00:00.000Z'");
  const gate=makeGate(db(file),{expectedGeneration:0,leaseId:'mine',now:NOW});
  assert.deepEqual(await gate(),{ok:true});
  assert.equal((await makeGate(db(file),{expectedGeneration:1,leaseId:'mine',now:NOW})()).reason,'marker_generation_moved');
  assert.equal((await makeGate(db(file),{expectedGeneration:0,leaseId:'other',now:NOW})()).reason,'lease_not_ours');
  sqlite(file,"UPDATE projection_run SET lease_until='2026-11-08T09:00:00.000Z'");
  assert.equal((await gate()).reason,'lease_not_ours','an expired lease is not ours');
  sqlite(file,"UPDATE film_person_baseline SET state='loading',reference='x';UPDATE film_person_baseline SET state='verified';UPDATE film_person_authority SET mode='prepared',generation=1");
  assert.equal((await makeGate(db(file),{expectedGeneration:0,leaseId:'mine',now:NOW})()).reason,'marker_not_r2');
 }
 // After convergence the next ledger has nothing to plan (idempotent re-run end to end).
 {
  const converged=await buildParityLedger({expected:{...cloneSide(actualSide),source:SOURCE},actual:actualSide,context});
  const next=await planReconciliation({diffs:converged.diffs,actual:actualSide,ledgerDigest:converged.ledger.digest});
  assert.equal(next.units.length,0);assert.equal(converged.ledger.totals.unexplained,0);
 }
}

// 7. The gate and the recorder on the stand-in: only a clean, complete, consistent, verified-source ledger passes, and recording never moves the marker.
{
 const clean=async(over={})=>{
  const ledger=(await buildParityLedger({expected:{classes:toClasses(fullRead.entries),complete:true,source:SOURCE},actual:{...actualSide}})).ledger;
  return {...ledger,...over};
 };
 const good=await clean();
 assert.deepEqual(await baselineGate(good),{pass:true,reasons:[]});
 const reasons=async over=>(await baselineGate(await clean(over))).reasons;
 assert.ok((await reasons({complete:false})).includes('incomplete'));
 assert.ok((await reasons({readConsistent:false})).includes('inconsistent_read'));
 assert.ok((await reasons({source:{aggregateSha256:'a'.repeat(64),verified:false}})).includes('source_unverified'));
 assert.ok((await reasons({source:{aggregateSha256:'short',verified:true}})).includes('source_unverified'));
 assert.ok((await reasons({source:null})).includes('source_unverified'));
 assert.ok((await reasons({classes:{...good.classes,retirement:{unavailable:true}}})).includes('class_unavailable:retirement'));
 assert.ok((await reasons({totals:{...good.totals,unexplained:1}})).some(item=>item.startsWith('unexplained:')));
 assert.ok((await reasons({digest:'0'.repeat(64)})).includes('digest_mismatch'),'a doctored ledger fails');
 assert.ok((await reasons({totals:{...good.totals,unexplained:0},classes:{...good.classes,film:{...good.classes.film,unexplained:{missing:0,extra:0,differs:0,total:9}}}})).includes('digest_mismatch'),'the digest covers the per-class unexplained counts');
 assert.deepEqual((await baselineGate(null)).reasons,['ledger_version']);
 // An unexplained difference is a failing ledger end to end.
 const bad=cloneSide(actualSide);bad.classes.film.push(['film:ghost','["x"]']);
 const failing=(await buildParityLedger({expected:{...bad,source:SOURCE},actual:actualSide,context})).ledger;
 assert.ok((await baselineGate(failing)).reasons.some(item=>item.startsWith('unexplained:')));

 const baselineOf=file=>rows(file,'SELECT state, reference FROM film_person_baseline')[0];
 const markerOf=file=>rows(file,'SELECT mode, cutover, generation FROM film_person_authority')[0];
 // Refusals change nothing: a failing gate, a marker that is not r2, a wrong generation.
 const target=database();
 await assert.rejects(()=>recordBaselineVerified(env(target),{ledger:failing,expectedGeneration:0,at:AT}),error=>error.code==='baseline_gate_failed'&&error.reasons.some(item=>item.startsWith('unexplained')));
 await assert.rejects(()=>recordBaselineVerified(env(target),{ledger:good,expectedGeneration:1,at:AT}),code('baseline_marker_not_r2'));
 assert.deepEqual(baselineOf(target),{state:'empty',reference:null});
 // Loading, then verified with the ledger digest as the reference; the marker is untouched; a replay is a no-op.
 assert.deepEqual(await markBaselineLoading(env(target),{reference:'run-1',expectedGeneration:0,at:AT}),{state:'loading',reference:'run-1'});
 assert.deepEqual(baselineOf(target),{state:'loading',reference:'run-1'});
 const recorded=await recordBaselineVerified(env(target),{ledger:good,expectedGeneration:0,at:AT});
 assert.deepEqual([recorded.state,recorded.reference,recorded.already],['verified',good.digest,false]);
 assert.deepEqual(baselineOf(target),{state:'verified',reference:good.digest});
 assert.deepEqual(markerOf(target),{mode:'r2',cutover:'open',generation:0},'recording the baseline never moves the marker');
 assert.equal((await recordBaselineVerified(env(target),{ledger:good,expectedGeneration:0,at:AT})).already,true);
 // A different ledger cannot overwrite a verified baseline; reopening it is allowed only through loading (r2 only).
 const other=await clean({digest:good.digest});
 other.totals={...other.totals};
 const differentLedger=(await buildParityLedger({expected:{classes:toClasses(fullRead.entries),complete:true,source:{aggregateSha256:'b'.repeat(64),verified:true}},actual:actualSide})).ledger;
 assert.notEqual(differentLedger.digest,good.digest);
 await assert.rejects(()=>recordBaselineVerified(env(target),{ledger:differentLedger,expectedGeneration:0,at:AT}),code('baseline_state_changed'));
 assert.equal((await markBaselineLoading(env(target),{reference:'run-2',expectedGeneration:0,at:AT})).state,'loading');
 assert.equal(baselineOf(target).state,'loading');
 // The marker beyond r2 refuses both writers (prepared and d1 stand on a verified baseline that is not reopened here).
 const prepared=database();
 sqlite(prepared,"UPDATE film_person_baseline SET state='loading',reference='t';UPDATE film_person_baseline SET state='verified';UPDATE film_person_authority SET mode='prepared',generation=1");
 await assert.rejects(()=>recordBaselineVerified(env(prepared),{ledger:good,expectedGeneration:1,at:AT}),code('baseline_marker_not_r2'));
 await assert.rejects(()=>markBaselineLoading(env(prepared),{reference:'x',expectedGeneration:1,at:AT}),code('baseline_marker_not_r2'));
 assert.equal(baselineOf(prepared).state,'verified');
 // Races between the read and the batch: the marker moves (nothing recorded), the baseline row changes (nothing recorded).
 const racing=database();
 const raceEnv={DB:d1Standin(racing,{onBatch:async()=>{sqlite(racing,"UPDATE film_person_baseline SET state='loading',reference='t';UPDATE film_person_baseline SET state='verified';UPDATE film_person_authority SET mode='prepared',generation=1");}})};
 await assert.rejects(()=>recordBaselineVerified(raceEnv,{ledger:good,expectedGeneration:0,at:AT}),code('baseline_marker_not_r2'));
 assert.equal(baselineOf(racing).reference,'t','the batch recorded nothing');
 const racing2=database();
 const raceEnv2={DB:d1Standin(racing2,{onBatch:async()=>{sqlite(racing2,"UPDATE film_person_baseline SET state='loading',reference='t';UPDATE film_person_baseline SET state='verified'");}})};
 await assert.rejects(()=>recordBaselineVerified(raceEnv2,{ledger:good,expectedGeneration:0,at:AT}),code('baseline_state_changed'));
 assert.deepEqual(baselineOf(racing2),{state:'verified',reference:'t'});
 await assert.rejects(()=>markBaselineLoading(env(target),{reference:'',expectedGeneration:0,at:AT}),code('baseline_invalid'));
 await assert.rejects(()=>recordBaselineVerified(env(target),{ledger:good,expectedGeneration:'0',at:AT}),code('baseline_invalid'));
}

// 8. Static: inactive. Nothing in src imports it, it is not bundled, it reads no R2 and calls no network, and the projector's files are unchanged by this card.
{
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&fs.readFileSync(full,'utf8').includes('film-person-baseline'))importers.push(full);}};
 walk('src');
 // the separate cutover_minimum gate (AIR-373) is the only other file that names it; nothing else imports that gate either
 assert.deepEqual(importers.filter(file=>!file.endsWith('film-person-baseline.js')&&!file.endsWith('film-person-cutover-minimum.js')),[],'no source file imports film-person-baseline');
 const gateImporters=[];
 const walkGate=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walkGate(full);else if(/\.(js|mjs)$/.test(entry.name)&&fs.readFileSync(full,'utf8').includes('film-person-cutover-minimum'))gateImporters.push(full);}};
 walkGate('src');
 // The recorder names the gate in exactly one place: the dynamic import inside its explicit, versioned cutover_minimum recording path (AIR-373). It has no
 // static import of the gate, and no other source file names it, so the Worker bundle (which does not reach film-person-baseline.js at all) cannot contain it.
 assert.deepEqual(gateImporters.filter(file=>!file.endsWith('film-person-cutover-minimum.js')).map(file=>file.split(path.sep).join('/')),['src/film-person-baseline.js'],'only the recorder names the cutover_minimum gate');
 const recorderText=fs.readFileSync('src/film-person-baseline.js','utf8').replace(/\/\/.*$/gm,'');
 assert.equal((recorderText.match(/film-person-cutover-minimum/g)||[]).length,1,'the recorder names the gate once');
 assert.ok(recorderText.includes("await import('./film-person-cutover-minimum.js')")&&!/^import[^;]*film-person-cutover-minimum/m.test(recorderText),'and only through the dynamic import of the explicit path');
 for(const file of ['build.mjs','package.json','wrangler.toml','wrangler.jsonc'])if(fs.existsSync(file))assert.ok(!fs.readFileSync(file,'utf8').includes('film-person-cutover-minimum'),file+' does not bundle the gate');
 for(const file of ['build.mjs','package.json','wrangler.toml','wrangler.jsonc'])if(fs.existsSync(file))assert.ok(!fs.readFileSync(file,'utf8').includes('film-person-baseline'),file+' does not bundle it');
 const text=fs.readFileSync('src/film-person-baseline.js','utf8').replace(/\/\/.*$/gm,'');
 assert.ok(!/\bR2\b|BUCKET|\.json['"]|fetch\(|child_process|process\.env/.test(text),'no R2, network, shell or environment access');
 for(const file of ['src/d1-enrichment.js','src/canonical-repository.js','src/enrichment-projection.js','src/worker.js'])assert.ok(!fs.readFileSync(file,'utf8').includes('film-person-baseline'),file+' is unchanged by this card');
 assert.ok(DEFAULT_EXPLANATIONS.every(rule=>rule.side==='extra'),'no default rule explains a missing or differing row');
}

console.log('film-person-baseline: the ledger counts, digests and classifies every difference by key only and explains it only by an explicit rule or owner exception; the reader pages by keyset, resumes and is bracketed by a consistent-read check; the plan is bounded and deterministic; the importer resumes from every checkpoint, settles unknown outcomes by readback, skips stale units and stops on a moved gate or a lost lease; the gate passes only a clean verified ledger and recording it never moves the marker; the module is inactive');
