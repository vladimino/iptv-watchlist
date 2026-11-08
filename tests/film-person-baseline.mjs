// AIR-373 stage A / ADR 0099 C6a: the offline baseline tooling: the parity ledger, the keyset D1 reader with its consistent-read check, the delta plan, the importer
// driver (checkpoint, resume, unknown outcomes, concurrent writer, generation and lease mismatch) and the baseline gate with its recorder. Fixtures and the sqlite3-CLI
// D1 stand-in only: no Worker, no R2, no production read or write; nothing here is bundled. Repeat against the real inputs in the production baseline (separate owner GOs).
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {CLASSES,DEFAULT_EXPLANATIONS,LIST_CAP,buildParityLedger,baselineGate,contextFromActual,expectedFromInputs,keyOf,makeGate,markBaselineLoading,planReconciliation,readConsistently,readD1State,readGate,readerOf,recordBaselineVerified,runImport,sha256Hex} from '../src/film-person-baseline.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-baseline-'));
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>name.replace(/\.sql$/,''));
let n=0;
const sqlite=(file,text)=>spawnSync('sqlite3',['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=spawnSync('sqlite3',['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
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
  "INSERT INTO person_alias (person_id,kind,value) VALUES ('person:director/1','name','Режиссёр'),('person:tmdb_actor/9','name','Актёр')",
  "INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES ('film:tmdb:1','person:director/1','director',0),('film:tmdb:1','person:actor/2','actor',0),('film:tmdb:1','person:tmdb_actor/9','actor',1),('film:tmdb:2','person:actor/3','actor',0)",
  "INSERT INTO film_dimension (film_id,dimension,status,source,provenance_json,value,authority,attempts,updated_at) VALUES ('film:tmdb:1','localization','reviewed','owner','{}','Владелец','owner',0,?1),('film:tmdb:2','localization','provisional','wikidata','{}','Автомат',NULL,0,?1)",
  "INSERT INTO person_dimension (person_id,dimension,status,source,provenance_json,value,authority,attempts,updated_at) VALUES ('person:director/1','localization','reviewed','dictionary','{}','Режиссёр',NULL,0,?1)",
  "INSERT INTO watchlist_film (film_id,updated_at) VALUES ('film:tmdb:1',?1),('film:tmdb:2',?1)",
  "INSERT INTO film_retention (film_id,basis,watchlist,evidence_json,request_id,observed_at,updated_at) VALUES ('film:retained','watchlist_fact',0,'{}','r1','2026-11-01T00:00:00.000Z',?1)",
  "INSERT INTO projection_state (projection,kind,id,change_key,projected_at) VALUES ('enrichment','film','film:tmdb:1','k1',?1),('enrichment','film','film:tmdb:2','k2',?1),('enrichment','film','film:tmdb:3','k3',?1),('enrichment','film','film:retained','k4',?1),('enrichment','person','person:director/1','p1',?1),('enrichment','person','person:actor/2','p2',?1),('enrichment','person','person:actor/3','p3',?1)",
 ].map(text=>text.replaceAll('?1',"'"+AT+"'")).join(';\n');
 const r=sqlite(file,insert);assert.equal(r.status,0,r.stderr);
}
async function readAll(handle,options={}){
 let read=await readConsistently(handle,{now:NOW,...options});
 while(!read.done)read=await readConsistently(handle,{state:read.state,now:NOW,...options});
 return read;
}
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
 const context={unkeyedPersons:new Set(['person:orphan']),retainedFilms:new Set(['film:retained'])};
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
 assert.deepEqual(c.watchlist,[['film:tmdb:1','null']],'only a listed Film is expected in the watchlist');
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

// 4. The consistent-read check: a moved marker, a changed baseline row or a foreign live lease invalidates the read; our own lease does not.
{
 const idle=await readConsistently(db(fixture),{now:NOW,pageSize:1000});
 assert.deepEqual([idle.done,idle.consistent,idle.reasons],[true,true,[]]);
 const moving=database();seed(moving);
 const hook=d1Standin(moving,{onQuery:async text=>{if(/FROM watchlist_film/.test(text)&&!hook.moved){hook.moved=true;sqlite(moving,"UPDATE film_person_baseline SET state='loading',reference='x' WHERE id=1");}}});
 const changed=await readConsistently(readerOf(hook),{now:NOW,pageSize:1000});
 assert.deepEqual([changed.consistent,changed.reasons],[false,['baseline_changed']]);
 const marker=database();seed(marker);
 const hook2=d1Standin(marker,{onQuery:async text=>{if(/FROM watchlist_film/.test(text)&&!hook2.moved){hook2.moved=true;sqlite(marker,"UPDATE film_person_baseline SET state='loading',reference='x';UPDATE film_person_baseline SET state='verified';UPDATE film_person_authority SET mode='prepared',generation=1");}}});
 const moved=await readConsistently(readerOf(hook2),{now:NOW,pageSize:1000});
 assert.ok(moved.reasons.includes('marker_moved'));assert.equal(moved.consistent,false);
 const leased=database();seed(leased);
 sqlite(leased,"INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES ('enrichment','foreign','2099-01-01T00:00:00.000Z','2026-11-08T09:00:00.000Z') ON CONFLICT(projection) DO UPDATE SET lease_id='foreign',lease_until='2099-01-01T00:00:00.000Z'");
 const foreign=await readConsistently(db(leased),{now:NOW,pageSize:1000,ownLeaseId:'mine'});
 assert.deepEqual([foreign.consistent,foreign.reasons],[false,['foreign_lease_live']]);
 assert.equal((await readConsistently(db(leased),{now:NOW,pageSize:1000,ownLeaseId:'foreign'})).consistent,true,'our own lease is allowed');
 // A lease row that names a holder but cannot be dated is treated as live, never as free.
 sqlite(leased,"UPDATE projection_run SET lease_until=NULL");
 const undated=await readConsistently(db(leased),{now:NOW,pageSize:1000,ownLeaseId:'mine'});
 assert.deepEqual([undated.consistent,undated.reasons],[false,['foreign_lease_live']]);
 sqlite(leased,"UPDATE projection_run SET lease_until='2026-11-08T09:59:00.000Z'");
 assert.equal((await readConsistently(db(leased),{now:NOW,pageSize:1000,ownLeaseId:'mine'})).consistent,true,'an expired lease is not live');
 const gate=await readGate(db(fixture),{now:AT});
 assert.deepEqual([gate.marker,gate.baseline.state,gate.lease.live],[{mode:'r2',cutover:'open',generation:0},'empty',false]);
 // The unavailable marker (a schema below 13) is reported, not invented.
 const legacy=database({upTo:chain.findIndex(name=>name.startsWith('0013_'))});
 assert.equal((await readGate(db(legacy),{now:AT})).marker,null);
 assert.ok((await readConsistently(db(legacy),{now:NOW,pageSize:1000})).reasons.includes('marker_unreadable'));
}

// 5. The expected side derived from the actual side with perturbations: the plan, the explanations from context, and the sample verification.
const actualSide={classes:toClasses(fullRead.entries),unavailable:fullRead.unavailable,complete:true,consistent:true};
const context=contextFromActual(actualSide);
{
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
 assert.deepEqual(importers.filter(file=>!file.endsWith('film-person-baseline.js')),[],'no source file imports film-person-baseline');
 for(const file of ['build.mjs','package.json','wrangler.toml','wrangler.jsonc'])if(fs.existsSync(file))assert.ok(!fs.readFileSync(file,'utf8').includes('film-person-baseline'),file+' does not bundle it');
 const text=fs.readFileSync('src/film-person-baseline.js','utf8').replace(/\/\/.*$/gm,'');
 assert.ok(!/\bR2\b|BUCKET|\.json['"]|fetch\(|child_process|process\.env/.test(text),'no R2, network, shell or environment access');
 for(const file of ['src/d1-enrichment.js','src/canonical-repository.js','src/enrichment-projection.js','src/worker.js'])assert.ok(!fs.readFileSync(file,'utf8').includes('film-person-baseline'),file+' is unchanged by this card');
 assert.ok(DEFAULT_EXPLANATIONS.every(rule=>rule.side==='extra'),'no default rule explains a missing or differing row');
}

console.log('film-person-baseline: the ledger counts, digests and classifies every difference by key only and explains it only by an explicit rule or owner exception; the reader pages by keyset, resumes and is bracketed by a consistent-read check; the plan is bounded and deterministic; the importer resumes from every checkpoint, settles unknown outcomes by readback, skips stale units and stops on a moved gate or a lost lease; the gate passes only a clean verified ledger and recording it never moves the marker; the module is inactive');
