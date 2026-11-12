// AIR-374 P3a Person and credit units (ADR 0126): the dormant EPG producer layer for `person_state` and `film_credits`, on the sqlite3-CLI D1 stand-in. No Worker, R2, D1 or Cloudflare access. Covered: the pure plan (order, duplicates,
// ordered credits, bounds), the route gate (one marker read below open; held throws), a bounded resumable pass (one atomic receipted batch per changed unit, no-op without a receipt, an absent Person or Film is never created, a missing credit
// Person or a redirected Film refuses before any receipt, one refusal never blocks the others, held stops the pass), preserved owned facts (an owner or reviewed Person value is kept, the incoming one becomes a conflict and an alias; D1-only
// credits survive; the Film row keeps its contract version, identity and title), the A to B to A flip, the pre-plan equal to the writer's own no-op test, the E5 race, the own-origin inline reconcile bound to the run, and the static dormancy.
// EPG_SRC points the file at a mutant copy of src/ (tests/canonical-epg-person-producer-mutation.mjs); EPG_TEMPLATE a prebuilt template database.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const SRC=process.env.EPG_SRC?path.resolve(process.env.EPG_SRC):path.resolve('src');
const load=name=>import(pathToFileURL(path.join(SRC,name)).href);
const P=await load('canonical-epg-person-producer.js');
const A=await load('canonical-person-adapters.js');
const {recordPersonState,readPersonStatePlan}=await load('canonical-person-state.js');
const {mutateFilm}=await load('canonical-mutations.js');
const {readAuthority}=await load('film-person-authority.js');
const {PRODUCER_WIRING,PRODUCER_OPERATIONS,handoffReadiness}=await load('canonical-producers.js');
const {producerRequestId}=await load('canonical-producer-adapters.js');
const {planEpgUnits,applyEpgUnits}=await load('canonical-epg-producer.js');
const {writeFilmFacts}=await load('canonical-film-writers.js');
const {planEpgPersonUnits,applyEpgPersonUnits,reconcileEpgRun,epgPersonReplan,EPG_UNIT_HARD_CAP}=P;
const {applyPersonState,applyFilmCredits,unitDigest,CREDITS_PER_UNIT_MAX,PERSON_STATE_OPERATION,FILM_CREDITS_OPERATION}=A;

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-epg-person-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const template=path.join(root,'template.sqlite');
if(process.env.EPG_TEMPLATE)fs.copyFileSync(process.env.EPG_TEMPLATE,template);
else{
 const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
 assert.equal(sqlite(template,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
}
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:01.000Z');";
let n=0;
function database(stage='open'){
 const file=path.join(root,'e-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 if(['r2','prepared','open','held'].includes(stage))assert.equal(sqlite(file,VERIFY).status,0);
 if(['prepared','open','held'].includes(stage))assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1").status,0);
 if(stage==='open'||stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1").status,0);
 if(stage==='open')assert.equal(sqlite(file,BASELINE).status,0);
 if(stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);
 return file;
}
const envOf=(file,options)=>({DB:d1Standin(file,options)});
const code=expected=>error=>error.code===expected;
const T='2026-11-11T10:00:00.000Z';
const iso=ms=>new Date(Date.parse(T)+ms).toISOString();
const FID=k=>'film:tmdb:'+k;
const PID=k=>'person:director/'+k;
const U='2026-11-01T00:00:00.000Z';
const q=value=>value==null?'NULL':"'"+String(value).replace(/'/g,"''")+"'";
const seedPersons=(file,ids)=>assert.equal(sqlite(file,ids.map(k=>"INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('"+PID(k)+"','director/"+k+"',1,'"+U+"');").join('')).status,0);
const seedFilm=(file,k,version=2,title='Kept Title')=>assert.equal(sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('"+FID(k)+"',"+version+",'ident"+k+"',"+q(title)+",'"+U+"')").status,0);
const dim=(slot,over={})=>({dimension:slot,status:'resolved',updatedAt:T,source:'letterboxd',sourceVersion:'director/1',provenance:{scope:'role'},nextAction:'stop',...over});
const loc=(value='Новое',over={})=>({dimension:'localization',status:'provisional',updatedAt:T,source:'wikidata',sourceVersion:'provisional',provenance:{value},value,nextAction:'keep_provisional',...over});
const reviewed=(value,authority,over={})=>loc(value,{status:'reviewed',source:authority,sourceVersion:authority,provenance:{authority,value},nextAction:'keep_reviewed',...over});
const state=(value='Новое')=>({identity:dim('identity'),localization:loc(value)});
const receipts=file=>rows(file,'SELECT request_id,operation,origin,target_kind,target_id,state,attempts,applied_revision,error_class FROM canonical_write_receipt ORDER BY target_id,operation,created_at');
const revision=(file,kind,id)=>Number(one(file,"SELECT revision FROM canonical_revision WHERE kind='"+kind+"' AND id='"+id+"'")??0);
const TABLES=['person','person_dimension','person_alias','localization_conflict','film','film_person_credit','canonical_revision','canonical_write_receipt'];
const dump=file=>JSON.stringify(TABLES.map(table=>[table,rows(file,'SELECT * FROM '+table+' ORDER BY 1,2,3')]));
const credits=file=>rows(file,"SELECT person_id,role,ordinal FROM film_person_credit WHERE film_id='"+FID(1)+"' ORDER BY role,ordinal");
const persons3=[{id:PID(3),state:state('C')},{id:PID(1),state:state('A')},{id:PID(2),state:state('B')}];
const films2=[{filmId:FID(2),credits:[{personId:PID(1),role:'director'}]},{filmId:FID(1),credits:[{personId:PID(3),role:'actor'},{personId:PID(1),role:'actor'},{personId:PID(2),role:'director'}]}];
const plan=(over={})=>planEpgPersonUnits({runId:'run-1',at:T,persons:persons3,credits:films2,...over});

// 1. The pure plan: Persons by id, then Films by id; the run id is the event; credits are an ORDERED, normalized list; malformed or oversized input refused.
{
 const p=plan();
 assert.equal(p.event,'epg:run-1');
 assert.deepEqual(p.units.map(unit=>[unit.kind,unit.id]),[[PERSON_STATE_OPERATION,PID(1)],[PERSON_STATE_OPERATION,PID(2)],[PERSON_STATE_OPERATION,PID(3)],[FILM_CREDITS_OPERATION,FID(1)],[FILM_CREDITS_OPERATION,FID(2)]]);
 assert.deepEqual(p.units[3].input.credits.map(credit=>credit.personId),[PID(3),PID(1),PID(2)],'the producer\'s own credit order is kept');
 assert.equal(JSON.stringify(plan()),JSON.stringify(plan({persons:[...persons3].reverse(),credits:[...films2].reverse()})),'unit order does not depend on the input order');
 const dirty=planEpgPersonUnits({runId:'r',at:T,credits:[{filmId:FID(1),credits:[{personId:PID(1),role:'actor',ordinal:9,x:1}]}]});
 assert.deepEqual(dirty.units[0].input.credits,[{personId:PID(1),role:'actor'}],'a credit carries a Person and a role only (no caller ordinal)');
 assert.deepEqual(planEpgPersonUnits({runId:'r',at:T}).units,[]);
 const state1=state();
 for(const bad of [{runId:''},{runId:7},{runId:'x'.repeat(281)},{at:''},{at:5},{persons:'x'},{credits:'x'},{persons:[...persons3,persons3[0]]},{persons:[{id:FID(1),state:state1}]},{persons:[{id:PID(1)}]},{persons:[null]},{persons:[{id:PID(1),state:{}}]},{persons:[{id:PID(1),state:[]}]},
  {credits:[...films2,films2[0]]},{credits:[{filmId:PID(1),credits:[{personId:PID(1),role:'actor'}]}]},{credits:[{filmId:FID(1),credits:[]}]},{credits:[{filmId:FID(1)}]},{credits:[{filmId:FID(1),credits:[{personId:FID(1),role:'actor'}]}]},
  {credits:[{filmId:FID(1),credits:[{personId:PID(1),role:'writer'}]}]},{credits:[{filmId:FID(1),credits:[{personId:PID(1),role:'actor'},{personId:PID(1),role:'actor'}]}]},{credits:[{filmId:FID(1),credits:[null]}]}])
  assert.throws(()=>plan(bad),code('film_person_invalid'),JSON.stringify(Object.keys(bad)));
 // A Person may hold the same role on a Film once, and two roles are two credits.
 assert.equal(planEpgPersonUnits({runId:'r',at:T,credits:[{filmId:FID(1),credits:[{personId:PID(1),role:'actor'},{personId:PID(1),role:'director'}]}]}).units[0].input.credits.length,2);
 const many=Array.from({length:CREDITS_PER_UNIT_MAX},(_,i)=>({personId:PID(i),role:'actor'}));
 assert.equal(planEpgPersonUnits({runId:'r',at:T,credits:[{filmId:FID(1),credits:many}]}).units[0].input.credits.length,CREDITS_PER_UNIT_MAX);
 assert.throws(()=>planEpgPersonUnits({runId:'r',at:T,credits:[{filmId:FID(1),credits:[...many,{personId:PID(999),role:'actor'}]}]}),code('film_person_bounded'));
 assert.ok(CREDITS_PER_UNIT_MAX+5<=60,'a credit unit fits the 60 statement cap of mutateFilm');
 assert.equal(EPG_UNIT_HARD_CAP,50);
 // The digests: a Person's observation time is content, the unit write clock is not; a credit list's order is content.
 const d1=await unitDigest(PERSON_STATE_OPERATION,{id:PID(1),at:T,person:state('A')}),d2=await unitDigest(PERSON_STATE_OPERATION,{id:PID(1),at:iso(99999),person:state('A')}),d3=await unitDigest(PERSON_STATE_OPERATION,{id:PID(1),at:T,person:state('B')});
 assert.equal(d1,d2);assert.notEqual(d1,d3);
 assert.notEqual(await unitDigest(PERSON_STATE_OPERATION,{id:PID(1),at:T,person:{...state('A'),localization:loc('A',{updatedAt:iso(5)})}}),d1,'the source observation time is content');
 assert.notEqual(await unitDigest(PERSON_STATE_OPERATION,{id:PID(2),at:T,person:state('A')}),d1,'the target is content');
 const c1=await unitDigest(FILM_CREDITS_OPERATION,{id:FID(1),at:T,credits:films2[1].credits});
 assert.notEqual(c1,await unitDigest(FILM_CREDITS_OPERATION,{id:FID(1),at:T,credits:[...films2[1].credits].reverse()}),'credit order is content');
 assert.equal(c1,await unitDigest(FILM_CREDITS_OPERATION,{id:FID(1),at:iso(5),credits:films2[1].credits.map(credit=>({...credit}))}));
 await assert.rejects(()=>unitDigest('film_facts',{id:FID(1)}),code('film_person_invalid'));
 await assert.rejects(()=>unitDigest(PERSON_STATE_OPERATION,{id:FID(1),person:state()}),code('film_person_invalid'));
 // The replay binding: only THIS run's unit of THIS kind for THIS target, with this run's request id.
 const replan=epgPersonReplan(p);
 const own=async(kind,id)=>{const unit=p.units.find(item=>item.kind===kind&&item.id===id),contentDigest=await unitDigest(kind,unit.input),target={kind:kind===PERSON_STATE_OPERATION?'person':'film',id};return {operation:kind,target,contentDigest,requestId:await producerRequestId({origin:'epg',operation:kind,event:p.event,target,digest:contentDigest})};};
 assert.equal((await replan(await own(PERSON_STATE_OPERATION,PID(2)))).person.localization.value,'B');
 assert.equal((await replan(await own(FILM_CREDITS_OPERATION,FID(1)))).credits.length,3);
 assert.equal(await replan({...(await own(PERSON_STATE_OPERATION,PID(2))),operation:FILM_CREDITS_OPERATION}),null,'another kind');
 assert.equal(await replan({...(await own(PERSON_STATE_OPERATION,PID(2))),requestId:(await own(PERSON_STATE_OPERATION,PID(1))).requestId}),null,'another request id');
 assert.equal(await replan({...(await own(PERSON_STATE_OPERATION,PID(2))),contentDigest:(await own(PERSON_STATE_OPERATION,PID(1))).contentDigest}),null,'another digest');
 assert.equal(await replan({operation:PERSON_STATE_OPERATION,target:{kind:'person',id:PID(77)}}),null);assert.equal(await replan({}),null);assert.equal(await epgPersonReplan(null)({operation:PERSON_STATE_OPERATION,target:{id:PID(1)}}),null);
 const other=plan({runId:'run-2'});
 assert.equal(await epgPersonReplan(other)(await own(PERSON_STATE_OPERATION,PID(2))),null,'a receipt of run 1 is not re-planned from run 2 with identical content');
}

// 2. Dormancy: below open a pass and an inline reconcile each cost exactly one marker read (SELECTs only), no batch, nothing written; held throws.
for(const stage of ['r2','prepared']){
 const file=database(stage),before=dump(file);
 const probe=envOf(file);await readAuthority(probe);
 const markerQueries=probe.DB.calls.queries;
 const seen=[];
 const env=envOf(file,{onQuery:async text=>{seen.push(text);}});
 const done=await applyEpgPersonUnits(env,{plan:plan(),now:()=>T});
 assert.equal(done.skipped,true,stage);assert.equal(done.reason,'projector_is_writer');assert.equal(done.cursor,0);assert.equal(done.done,false);
 assert.equal(env.DB.calls.queries,markerQueries,stage+': exactly one marker read');
 assert.ok(seen.every(text=>/^\s*SELECT/i.test(text)));assert.equal(env.DB.calls.batches,0);
 assert.equal((await reconcileEpgRun(env,{plan:plan()})).skipped,true);
 assert.equal(env.DB.calls.queries,2*markerQueries,stage+': the reconcile reads only the marker');
 for(const apply of [applyPersonState,applyFilmCredits]){
  const direct=envOf(file);
  const out=await apply(direct,{origin:'epg',event:'epg:x',input:apply===applyPersonState?{id:PID(1),at:T,person:state()}:{id:FID(1),at:T,credits:films2[1].credits}});
  assert.deepEqual([out.state,out.receipt],['skipped',false]);assert.equal(direct.DB.calls.queries,markerQueries);
 }
 assert.equal(dump(file),before,stage+': nothing written');
}
{
 const env=envOf(database('held'));
 await assert.rejects(()=>applyEpgPersonUnits(env,{plan:plan()}),code('film_person_held'));
 await assert.rejects(()=>reconcileEpgRun(env,{plan:plan()}),code('film_person_held'));
 await assert.rejects(()=>applyPersonState(env,{origin:'epg',event:'e',input:{id:PID(1),at:T,person:state()}}),code('film_person_held'));
 assert.equal(env.DB.calls.batches,0);
 const open=envOf(database('open'));
 for(const bad of [{plan:null},{plan:{units:[]}},{plan:{units:'x',event:'e'}},{plan:plan(),cursor:-1},{plan:plan(),cursor:1.5}])
  await assert.rejects(()=>applyEpgPersonUnits(open,bad),code('film_person_invalid'),JSON.stringify(Object.keys(bad)));
 assert.equal(open.DB.calls.queries,0,'a malformed call reads nothing');
}

// 3. open: a bounded, resumable pass. Persons exist, the Film exists with a contract version, identity and title of its own and one D1-only credit; absent Person and Film are never created.
{
 const file=database('open');
 seedPersons(file,[1,2,3,9]);seedFilm(file,1);seedFilm(file,5,3,'Other');
 assert.equal(sqlite(file,"INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES ('"+FID(1)+"','"+PID(9)+"','actor',0)").status,0);
 const filmRow=id=>JSON.stringify(rows(file,"SELECT * FROM film WHERE id='"+id+"'"));
 const p=plan({persons:[...persons3,{id:PID(77),state:state('Z')}],credits:[...films2,{filmId:FID(88),credits:[{personId:PID(1),role:'actor'}]}]});
 assert.deepEqual(p.units.map(unit=>unit.id),[PID(1),PID(2),PID(3),PID(77),FID(1),FID(2),FID(88)]);
 const env=envOf(file);
 const first=await applyEpgPersonUnits(env,{plan:p,limit:3,now:()=>T});
 assert.deepEqual([first.skipped,first.cursor,first.done,first.counts.applied,first.counts.noop,first.failures.length,first.stoppedBy],[false,3,false,3,0,0,null]);
 assert.equal(env.DB.calls.batches,6,'two batches per changed unit: the pending insert and the writer own');
 assert.equal(one(file,"SELECT COUNT(*) FROM film_person_credit WHERE film_id='"+FID(1)+"'"),1,'no credit is written before the credit units');
 const before={1:filmRow(FID(1)),5:filmRow(FID(5))};
 const second=await applyEpgPersonUnits(env,{plan:p,cursor:first.cursor,limit:10,now:()=>iso(1000)});
 assert.deepEqual([second.cursor,second.done,second.counts.applied,second.counts.absent,second.counts.noop,second.failures.length],[7,true,1,3,0,0],'one credit unit applied; an absent Person, an absent Film (two) skipped');
 const list=receipts(file);
 assert.equal(list.length,4);
 assert.ok(list.every(item=>item.origin==='epg'&&item.state==='applied'&&item.applied_revision===1&&/^epg:(person_state|film_credits):[0-9a-f]{64}$/.test(item.request_id)),JSON.stringify(list));
 assert.deepEqual(list.map(item=>[item.operation,item.target_kind]).sort().join('|'),[['film_credits','film'],['person_state','person'],['person_state','person'],['person_state','person']].join('|'));
 assert.equal(new Set(list.map(item=>item.request_id)).size,4);
 assert.equal(one(file,"SELECT COUNT(*) FROM person WHERE id='"+PID(77)+"'"),0,'an absent Person is never created');
 assert.equal(one(file,"SELECT COUNT(*) FROM film WHERE id IN ('"+FID(2)+"','"+FID(88)+"')"),0,'an absent Film is never created');
 assert.equal(one(file,"SELECT COUNT(*) FROM person_dimension WHERE person_id='"+PID(77)+"'"),0);
 // The credits are appended in the producer's order after the D1-only credit of the same role; that credit survives; the Film row keeps its contract version, identity and title.
 assert.deepEqual(credits(file),[{person_id:PID(9),role:'actor',ordinal:0},{person_id:PID(3),role:'actor',ordinal:1},{person_id:PID(1),role:'actor',ordinal:2},{person_id:PID(2),role:'director',ordinal:0}]);
 assert.deepEqual(rows(file,"SELECT contract_version,canonical_identity,original_title,updated_at FROM film WHERE id='"+FID(1)+"'"),[{contract_version:2,canonical_identity:'ident1',original_title:'Kept Title',updated_at:T}],'identity, title and contract version are kept; the unit write clock moves updated_at');
 assert.equal(filmRow(FID(5)),before[5],'an unrelated Film is untouched');
 assert.equal(revision(file,'film',FID(1)),1);assert.equal(revision(file,'person',PID(1)),1);
 assert.deepEqual(rows(file,"SELECT dimension,status,value FROM person_dimension WHERE person_id='"+PID(1)+"' ORDER BY dimension"),[{dimension:'identity',status:'resolved',value:null},{dimension:'localization',status:'provisional',value:'A'}]);
 // Again, and under a new run with the same facts: every unit is a no-op (absent ones stay absent), no receipt, no batch, identical database.
 const stable=dump(file);
 for(const [runId,at] of [['run-1',T],['run-2',iso(60000)]]){
  const again=envOf(file);
  const out=await applyEpgPersonUnits(again,{plan:planEpgPersonUnits({runId,at,persons:[...persons3,{id:PID(77),state:state('Z')}],credits:[...films2,{filmId:FID(88),credits:[{personId:PID(1),role:'actor'}]}]}),limit:50,now:()=>at});
  assert.deepEqual([out.done,out.counts.noop,out.counts.absent,out.counts.applied,out.failures.length],[true,4,3,0,0],runId);
  assert.equal(again.DB.calls.batches,0,runId);assert.equal(dump(file),stable,runId);
 }
 // A new credit under a new run is a new request; the stored credits keep their ordinals.
 const more=planEpgPersonUnits({runId:'run-3',at:iso(120000),credits:[{filmId:FID(1),credits:[{personId:PID(1),role:'actor'},{personId:PID(1),role:'director'}]}]});
 const third=await applyEpgPersonUnits(envOf(file),{plan:more,now:()=>iso(120000)});
 assert.deepEqual([third.counts.applied,third.counts.noop,revision(file,'film',FID(1))],[1,0,2]);
 assert.deepEqual(credits(file).filter(row=>row.role==='director').map(row=>[row.person_id,row.ordinal]),[[PID(2),0],[PID(1),1]],'a new director is appended after the stored one; the stored ordinal is kept');
}

// 4. Refusals before any receipt: a credit whose Person is missing, a redirected Film. One refusal never blocks the others and nothing is created.
{
 const file=database('open');
 seedPersons(file,[1,2]);seedFilm(file,1);seedFilm(file,2);seedFilm(file,3);
 assert.equal(sqlite(file,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('"+FID(3)+"','"+FID(1)+"','"+U+"')").status,0);
 const p=planEpgPersonUnits({runId:'ref',at:T,credits:[{filmId:FID(1),credits:[{personId:PID(1),role:'actor'},{personId:PID(404),role:'actor'}]},{filmId:FID(2),credits:[{personId:PID(2),role:'actor'}]},{filmId:FID(3),credits:[{personId:PID(1),role:'actor'}]}]});
 const out=await applyEpgPersonUnits(envOf(file),{plan:p,now:()=>T});
 assert.deepEqual([out.done,out.counts.applied,out.counts.failed],[true,1,2]);
 assert.deepEqual(out.failures,[{id:FID(1),code:'film_person_reference'},{id:FID(3),code:'film_person_redirect'}]);
 assert.equal(receipts(file).length,1,'no receipt for a refusal raised before it');
 assert.equal(one(file,"SELECT COUNT(*) FROM film_person_credit WHERE film_id='"+FID(1)+"'"),0,'the credit of the resolvable Person is not written either: the unit is refused whole');
 assert.equal(one(file,"SELECT COUNT(*) FROM person WHERE id='"+PID(404)+"'"),0,'a missing Person is never created');
 // A credit that is already stored needs no Person lookup: only the MISSING credits are checked.
 assert.equal(sqlite(file,"INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES ('"+FID(1)+"','"+PID(1)+"','actor',0)").status,0);
 const again=await applyEpgPersonUnits(envOf(file),{plan:planEpgPersonUnits({runId:'ref2',at:T,credits:[{filmId:FID(1),credits:[{personId:PID(1),role:'actor'}]}]}),now:()=>T});
 assert.deepEqual([again.counts.noop,again.counts.failed],[1,0]);
}

// 5. Preserved owned facts and the A to B to A flip of a Person. An owner-reviewed localization is never downgraded: the incoming value becomes a conflict and an alias, one receipt, and the repeat is a no-op.
{
 const file=database('open');
 seedPersons(file,[1]);
 const T0=iso(-3600000);
 assert.equal(sqlite(file,"INSERT INTO person_dimension (person_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ('"+PID(1)+"','localization','reviewed','owner','owner','{\"authority\":\"owner\",\"value\":\"Владелец\"}','Владелец','owner',0,'keep_reviewed','"+T0+"')").status,0);
 const run=(runId,value,at=T)=>applyEpgPersonUnits(envOf(file),{plan:planEpgPersonUnits({runId,at,persons:[{id:PID(1),state:{localization:loc(value)}}]}),now:()=>at});
 const first=await run('own-1','Автомат');
 assert.deepEqual([first.counts.applied,first.counts.failed],[1,0]);
 assert.deepEqual(rows(file,"SELECT status,value,authority,updated_at FROM person_dimension WHERE person_id='"+PID(1)+"' AND dimension='localization'"),[{status:'reviewed',value:'Владелец',authority:'owner',updated_at:T0}],'the owner value and its clock are kept');
 assert.deepEqual(rows(file,"SELECT value FROM person_alias WHERE person_id='"+PID(1)+"'"),[{value:'Автомат'}]);
 assert.deepEqual(rows(file,"SELECT reason,value FROM localization_conflict WHERE entity_id='"+PID(1)+"'"),[{reason:'owner_kept',value:'Автомат'}]);
 assert.equal(revision(file,'person',PID(1)),1);
 const stable=dump(file),env2=envOf(file);
 const second=await applyEpgPersonUnits(env2,{plan:planEpgPersonUnits({runId:'own-2',at:iso(60000),persons:[{id:PID(1),state:{localization:loc('Автомат')}}]}),now:()=>iso(60000)});
 assert.deepEqual([second.counts.noop,second.counts.applied],[1,0]);assert.equal(env2.DB.calls.batches,0);assert.equal(dump(file),stable,'the held value is recorded once');
 // An owner review may replace an owner value (the writer's own rule); an automatic value may not.
 const third=await run('own-3','Режиссёр',iso(120000));
 assert.equal(third.counts.applied,1);
}
{
 const file=database('open');
 seedPersons(file,[1]);
 const flip=(runId,value)=>applyEpgPersonUnits(envOf(file),{plan:planEpgPersonUnits({runId,at:T,persons:[{id:PID(1),state:{localization:loc(value)}}]}),now:()=>T});
 const a=await flip('f-1','A'),b=await flip('f-2','B'),c=await flip('f-3','A');
 assert.deepEqual([a.counts.applied,b.counts.applied,c.counts.applied,c.counts.already,c.counts.noop,revision(file,'person',PID(1))],[1,1,1,0,0,3]);
 assert.equal(one(file,"SELECT value FROM person_dimension WHERE person_id='"+PID(1)+"' AND dimension='localization'"),'A');
 assert.equal(new Set(receipts(file).map(item=>item.request_id)).size,3,'A to B to A is three requests, never the first one read as already applied');
 // The same run again after another actor moved the Person: the same request id, read as already applied, and not rewritten.
 await recordPersonState(envOf(file),{id:PID(1),expectedRevision:3,at:T,requestId:'interloper',person:{localization:loc('Z')}});
 const again=await flip('f-3','A');
 assert.deepEqual([again.counts.already,again.counts.applied,revision(file,'person',PID(1))],[1,0,4]);
}

// 6. The pre-plan is the writer's own test: readPersonStatePlan says noop exactly when recordPersonState answers `already`, absent exactly for a missing Person, and the revision is the entity's.
{
 const file=database('open');
 seedPersons(file,[1]);
 const env=envOf(file);
 const input={id:PID(1),at:T,person:state('A')};
 assert.deepEqual(await readPersonStatePlan(env,input),{absent:false,noop:false,revision:0});
 assert.deepEqual(await readPersonStatePlan(env,{...input,id:PID(5)}),{absent:true,noop:false,revision:0});
 const wrote=await recordPersonState(env,{...input,expectedRevision:0,requestId:'w1'});
 assert.equal(wrote.already,false);
 assert.deepEqual(await readPersonStatePlan(env,input),{absent:false,noop:true,revision:1});
 assert.equal((await recordPersonState(env,{...input,expectedRevision:1,requestId:'w2'})).already,true,'the writer agrees');
 const other={...input,person:state('B')};
 assert.equal((await readPersonStatePlan(env,other)).noop,false);
 assert.equal((await recordPersonState(env,{...other,expectedRevision:1,requestId:'w3'})).already,false);
 await assert.rejects(()=>readPersonStatePlan(env,{id:PID(1),person:{}}),code('film_person_invalid'));
 await assert.rejects(()=>readPersonStatePlan(env,{id:'film:x',person:state()}),code('film_person_invalid'));
 await assert.rejects(()=>readPersonStatePlan(env,{id:PID(1)}),code('film_person_invalid'));
 assert.equal(file&&dump(file).length>0,true);
}

// 7. A marker that goes held mid-pass stops the pass ON the unit it refused; the cursor stays there.
{
 const file=database('open');
 seedPersons(file,[1,2,3]);
 let flipped=false,env=null;
 env=envOf(file,{onQuery:async text=>{
  if(!flipped&&env.DB.calls.batches>=2&&/film_person_authority/.test(text)){flipped=true;assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);}
 }});
 const out=await applyEpgPersonUnits(env,{plan:plan({credits:[]}),now:()=>T});
 assert.deepEqual([out.skipped,out.cursor,out.done,out.stoppedBy,out.counts.applied,out.counts.failed],[false,1,false,'film_person_held',1,0]);
 assert.equal(one(file,"SELECT COUNT(*) FROM person_dimension WHERE person_id='"+PID(2)+"'"),0);
}

// 8. E5: identical content landing between the pre-plan and the writer ends the receipt `unknown` (no second batch), for a Person state and for a credit unit.
{
 const file=database('open');
 seedPersons(file,[1,2]);seedFilm(file,1);
 const p=planEpgPersonUnits({runId:'e5',at:T,persons:[{id:PID(1),state:state('A')}],credits:[{filmId:FID(1),credits:[{personId:PID(2),role:'actor'}]}]});
 let seen=0;
 const env=envOf(file,{onBatch:async()=>{
  seen++;
  if(seen===1)await recordPersonState(envOf(file),{id:PID(1),expectedRevision:0,at:T,requestId:'interloper',person:state('A')});
  if(seen===3)await mutateFilm(envOf(file),{id:FID(1),expectedRevision:0,at:T,film:{contractVersion:2},credits:{upsert:[{personId:PID(2),role:'actor'}]}});
 }});
 const out=await applyEpgPersonUnits(env,{plan:p,now:()=>T});
 assert.deepEqual([out.counts.unknown,out.counts.applied,out.failures.length],[2,0,0]);
 assert.equal(env.DB.calls.batches,4,'two per unit: the pending insert and the transition to unknown; never a marking batch');
 assert.deepEqual(receipts(file).map(item=>[item.operation,item.state,item.error_class]),[['film_credits','unknown','atomic_mark_missing'],['person_state','unknown','atomic_mark_missing']]);
}

// 9. Stale revision and the inline reconcile (E2), bound to the run: an interloper moves the entity between the pre-plan and the writer batch. The pass counts it failed (retryable); the own-origin reconcile re-validates and replays the SAME
// request id and the receipt ends applied at attempt 2. Another run's plan, an empty plan or a changed source never replays it.
for(const kind of ['person','credits']){
 const setup=()=>{
  const file=database('open');
  seedPersons(file,[1,2]);seedFilm(file,1);
  const p=kind==='person'?planEpgPersonUnits({runId:'run-7',at:T,persons:[{id:PID(1),state:state('A')}]}):planEpgPersonUnits({runId:'run-7',at:T,credits:[{filmId:FID(1),credits:[{personId:PID(2),role:'actor'}]}]});
  const move=()=>kind==='person'
   ?recordPersonState(envOf(file),{id:PID(1),expectedRevision:0,at:T,requestId:'interloper',person:state('Z')})
   :mutateFilm(envOf(file),{id:FID(1),expectedRevision:0,at:T,film:{contractVersion:2},credits:{upsert:[{personId:PID(1),role:'director'}]}});
  let seen=0;
  const racing=envOf(file,{onBatch:async()=>{seen++;if(seen===2)await move();}});
  return {file,p,racing};
 };
 const settled=file=>receipts(file)[0];
 {
  const {file,p,racing}=setup();
  const out=await applyEpgPersonUnits(racing,{plan:p,now:()=>T});
  assert.deepEqual([out.counts.failed,out.failures.map(item=>item.code)],[1,['film_person_revision_conflict']],kind);
  assert.deepEqual([settled(file).state,settled(file).attempts],['failed',1]);
  assert.equal((await reconcileEpgRun(envOf(file),{plan:p,now:()=>iso(1000)})).considered,0,'before the backoff nothing is due');
  const ok=await reconcileEpgRun(envOf(file),{plan:p,now:()=>iso(61000)});
  assert.equal(ok.considered,1);
  assert.deepEqual([settled(file).state,settled(file).attempts,settled(file).applied_revision,settled(file).origin],['applied',2,2,'epg'],kind+': '+JSON.stringify(ok));
  if(kind==='person')assert.equal(one(file,"SELECT value FROM person_dimension WHERE person_id='"+PID(1)+"' AND dimension='localization'"),'A');
  else assert.equal(one(file,"SELECT COUNT(*) FROM film_person_credit WHERE film_id='"+FID(1)+"'"),2);
 }
 {
  const {file,p,racing}=setup();
  await applyEpgPersonUnits(racing,{plan:p,now:()=>T});
  const blind=await reconcileEpgRun(envOf(file),{plan:{event:'epg:none',units:[]},now:()=>iso(61000)});
  assert.equal(blind.considered,1);
  assert.deepEqual([settled(file).state,settled(file).error_class],['abandoned','stale_revision_needs_repair'],kind+': no re-plan after a moved revision: repair, never a blind replay');
 }
 {
  const {file,p,racing}=setup();
  await applyEpgPersonUnits(racing,{plan:p,now:()=>T});
  const otherRun=kind==='person'?planEpgPersonUnits({runId:'run-8',at:T,persons:[{id:PID(1),state:state('A')}]}):planEpgPersonUnits({runId:'run-8',at:T,credits:[{filmId:FID(1),credits:[{personId:PID(2),role:'actor'}]}]});
  await reconcileEpgRun(envOf(file),{plan:otherRun,now:()=>iso(61000)});
  assert.notEqual(settled(file).state,'applied',kind+': run B does not settle run A\'s request');
  assert.equal(settled(file).request_id,receipts(file)[0].request_id);
 }
 {
  const {file,p,racing}=setup();
  await applyEpgPersonUnits(racing,{plan:p,now:()=>T});
  const moved=kind==='person'?planEpgPersonUnits({runId:'run-7',at:T,persons:[{id:PID(1),state:state('Other')}]}):planEpgPersonUnits({runId:'run-7',at:T,credits:[{filmId:FID(1),credits:[{personId:PID(1),role:'actor'}]}]});
  const gone=await reconcileEpgRun(envOf(file),{plan:moved,now:()=>iso(61000)});
  assert.equal(gone.abandoned.length,1);assert.equal(settled(file).error_class,'producer_source_changed',kind+': a source that moved on is never replayed');
 }
}
// 9b. The inline reconcile covers ALL kinds of the origin in one bounded pass and honours its limit: two due receipts, one considered.
{
 const file=database('open');
 seedPersons(file,[1,2]);seedFilm(file,1);
 const p=planEpgPersonUnits({runId:'run-9',at:T,persons:[{id:PID(1),state:state('A')}],credits:[{filmId:FID(1),credits:[{personId:PID(2),role:'actor'}]}]});
 let seen=0;
 const env=envOf(file,{onBatch:async()=>{seen++;if(seen===2)await recordPersonState(envOf(file),{id:PID(1),expectedRevision:0,at:T,requestId:'i1',person:state('Z')});if(seen===4)await mutateFilm(envOf(file),{id:FID(1),expectedRevision:0,at:T,film:{contractVersion:2},credits:{upsert:[{personId:PID(1),role:'director'}]}});}});
 const out=await applyEpgPersonUnits(env,{plan:p,now:()=>T});
 assert.deepEqual([out.counts.failed,receipts(file).length,receipts(file).every(item=>item.state==='failed')],[2,2,true]);
 assert.equal((await reconcileEpgRun(envOf(file),{plan:p,limit:1,now:()=>iso(61000)})).considered,1,'the limit bounds the pass');
 assert.equal((await reconcileEpgRun(envOf(file),{plan:p,limit:10,now:()=>iso(61000)})).considered,1);
 assert.deepEqual(receipts(file).map(item=>item.state),['applied','applied']);
}

// 9c. A due receipt whose interloper wrote the SAME content is never replayed and never marked applied (content alone is not proof of THIS request): it goes to review, and nothing is written. The spec's revalidate says
// superseded for an absent entity or facts already stored, proceed for facts still to write, and stale without a usable re-plan.
for(const kind of ['person','credits']){
 const file=database('open');
 seedPersons(file,[1,2]);seedFilm(file,1);
 const p=kind==='person'?planEpgPersonUnits({runId:'run-s',at:T,persons:[{id:PID(1),state:state('A')}]}):planEpgPersonUnits({runId:'run-s',at:T,credits:[{filmId:FID(1),credits:[{personId:PID(2),role:'actor'}]}]});
 let seen=0;
 const racing=envOf(file,{onBatch:async()=>{seen++;if(seen===2){if(kind==='person')await recordPersonState(envOf(file),{id:PID(1),expectedRevision:0,at:T,requestId:'same',person:state('A')});else await mutateFilm(envOf(file),{id:FID(1),expectedRevision:0,at:T,film:{contractVersion:2},credits:{upsert:[{personId:PID(2),role:'actor'}]}});}}});
 const out=await applyEpgPersonUnits(racing,{plan:p,now:()=>T});
 assert.equal(out.counts.failed,1,kind);
 const before=dump(file).replace(/"canonical_write_receipt".*$/,'');
 const done=await reconcileEpgRun(envOf(file),{plan:p,now:()=>iso(61000)});
 assert.equal(done.needsReview.length,1,kind+': '+JSON.stringify(done));
 assert.equal(receipts(file)[0].state,'abandoned',kind);
 assert.equal(dump(file).replace(/"canonical_write_receipt".*$/,''),before,kind+': nothing is written');
}
{
 const file=database('open');
 seedPersons(file,[1,2]);seedFilm(file,1);
 const env=envOf(file);
 const pinput={id:PID(1),at:T,person:state('A')};
 const mk=async(operation,input,kind,id)=>({operation,contentDigest:await unitDigest(operation,input),target:{kind,id},requestId:'r'});
 const personReceipt=await mk(PERSON_STATE_OPERATION,pinput,'person',PID(1));
 const personSpec=input=>A.unitOperation(PERSON_STATE_OPERATION,{replan:async()=>input});
 assert.equal(await personSpec(pinput).revalidate(env,personReceipt),'proceed','facts still to write');
 assert.equal(await personSpec(null).revalidate(env,personReceipt),'stale','no re-plan');
 assert.equal(await personSpec({...pinput,person:state('Other')}).revalidate(env,personReceipt),'stale','a source that moved on');
 assert.equal(await personSpec({id:PID(1)}).revalidate(env,personReceipt),'stale','a refusal');
 assert.equal(await personSpec(pinput).revalidate(env,{...personReceipt,target:{kind:'person',id:PID(1)}}),'proceed');
 const gone={...pinput,id:PID(404)};
 assert.equal(await A.unitOperation(PERSON_STATE_OPERATION,{replan:async()=>gone}).revalidate(env,await mk(PERSON_STATE_OPERATION,gone,'person',PID(404))),'superseded','an absent Person is never created');
 await recordPersonState(env,{...pinput,expectedRevision:0,requestId:'w'});
 assert.equal(await personSpec(pinput).revalidate(env,personReceipt),'superseded','facts already stored');
 assert.deepEqual(await personSpec(pinput).readback(env,personReceipt.target,personReceipt),{digest:personReceipt.contentDigest,revision:1});
 assert.deepEqual(await personSpec({...pinput,person:state('B')}).readback(env,personReceipt.target,{...personReceipt,contentDigest:await unitDigest(PERSON_STATE_OPERATION,{...pinput,person:state('B')})}),{digest:null,revision:1});
 assert.deepEqual(await personSpec(null).readback(env,personReceipt.target,personReceipt),{digest:null,revision:1});
 assert.deepEqual(await personSpec({...pinput,person:state('B')}).readback(env,personReceipt.target,personReceipt),{disposition:'abandon',errorClass:'producer_source_changed'});
 assert.deepEqual(await A.unitOperation(PERSON_STATE_OPERATION,{replan:async()=>gone}).readback(env,{kind:'person',id:PID(404)},await mk(PERSON_STATE_OPERATION,gone,'person',PID(404))),{digest:null,revision:0},'an absent Person reads back absent');
 const cinput={id:FID(1),at:T,credits:[{personId:PID(2),role:'actor'}]};
 const creditReceipt=await mk(FILM_CREDITS_OPERATION,cinput,'film',FID(1));
 const creditSpec=A.unitOperation(FILM_CREDITS_OPERATION,{replan:async()=>cinput});
 assert.equal(await creditSpec.revalidate(env,creditReceipt),'proceed');
 assert.deepEqual(await creditSpec.readback(env,creditReceipt.target,creditReceipt),{digest:null,revision:0});
 await mutateFilm(env,{id:FID(1),expectedRevision:0,at:T,film:{contractVersion:2},credits:{upsert:cinput.credits}});
 assert.equal(await creditSpec.revalidate(env,creditReceipt),'superseded');
 assert.deepEqual(await creditSpec.readback(env,creditReceipt.target,creditReceipt),{digest:creditReceipt.contentDigest,revision:1});
 assert.equal(env.DB.calls.batches,2,'only the two writes above');
}
{
 const file=database('open');
 seedPersons(file,[1,2]);seedFilm(file,1);
 const p=planEpgPersonUnits({runId:'run-u',at:T,persons:[{id:PID(1),state:state('A')}],credits:[{filmId:FID(1),credits:[{personId:PID(2),role:'actor'}]}]});
 let seen=0;
 const env=envOf(file,{onBatch:async()=>{seen++;if(seen===1)await recordPersonState(envOf(file),{id:PID(1),expectedRevision:0,at:T,requestId:'i',person:state('A')});if(seen===3)await mutateFilm(envOf(file),{id:FID(1),expectedRevision:0,at:T,film:{contractVersion:2},credits:{upsert:[{personId:PID(2),role:'actor'}]}});}});
 await applyEpgPersonUnits(env,{plan:p,now:()=>T});
 const stable=dump(file).replace(/"canonical_write_receipt".*$/,'');
 const rec=await reconcileEpgRun(envOf(file),{plan:p,now:()=>iso(3600000)});
 assert.equal(rec.considered,2);
 assert.deepEqual(receipts(file).map(item=>item.state),['abandoned','abandoned'],'content alone is never proof: the unknown receipts are sent to review, not marked applied: '+JSON.stringify(rec));
 assert.equal(dump(file).replace(/"canonical_write_receipt".*$/,''),stable,'no second write');
}
// 9d. The spec's replay refuses a source that moved on and one it cannot re-plan; a Film that vanished between the pre-plan and the writer is refused, never created.
{
 const file=database('open');
 seedPersons(file,[1,2]);seedFilm(file,1);
 const env=envOf(file);
 const input={id:PID(1),at:T,person:state('A')};
 const digest=await unitDigest(PERSON_STATE_OPERATION,input);
 const receipt={requestId:'epg:person_state:'+digest,contentDigest:digest,target:{kind:'person',id:PID(1)},operation:PERSON_STATE_OPERATION};
 const ctx={requestId:receipt.requestId,attempt:2,target:receipt.target,currentRevision:0};
 await assert.rejects(()=>A.unitOperation(PERSON_STATE_OPERATION,{replan:async()=>({...input,person:state('Other')})}).replay(env,receipt,ctx),code('film_person_invalid'));
 await assert.rejects(()=>A.unitOperation(PERSON_STATE_OPERATION,{replan:async()=>null}).replay(env,receipt,ctx),code('producer_replan_unavailable'));
 await assert.rejects(()=>A.unitOperation(PERSON_STATE_OPERATION,{replan:async()=>{throw new Error('x');}}).replay(env,receipt,ctx),code('producer_replan_unavailable'));
 assert.throws(()=>A.unitOperation('film_facts',{replan:async()=>null}),code('film_person_invalid'));assert.throws(()=>A.unitOperation(PERSON_STATE_OPERATION,{}),code('film_person_invalid'));
 assert.equal(env.DB.calls.batches,0,'a refused replay writes nothing');
 const p=planEpgPersonUnits({runId:'run-v',at:T,credits:[{filmId:FID(1),credits:[{personId:PID(2),role:'actor'}]}]});
 let seen=0;
 const vanishing=envOf(file,{onBatch:async()=>{seen++;if(seen===1)assert.equal(sqlite(file,"DELETE FROM film WHERE id='"+FID(1)+"'").status,0);}});
 const out=await applyEpgPersonUnits(vanishing,{plan:p,now:()=>T});
 assert.deepEqual([out.counts.failed,out.failures],[1,[{id:FID(1),code:'film_person_reference'}]]);
 assert.equal(one(file,"SELECT COUNT(*) FROM film WHERE id='"+FID(1)+"'"),0,'a vanished Film is not recreated');
 assert.equal(receipts(file)[0].state,'abandoned');
 await assert.rejects(()=>unitDigest(FILM_CREDITS_OPERATION,{id:FID(1),credits:Array.from({length:CREDITS_PER_UNIT_MAX+1},(_,i)=>({personId:PID(i),role:'actor'}))}),code('film_person_invalid'));
}
// 9e. The reconcile of the origin also settles `film_facts` receipts of the Film layer (ADR 0125) from the Film plan, and one pass covers every kind.
{
 const file=database('open');
 const films=[{id:FID(1),facts:{film:{contractVersion:1,originalTitle:'A',source:'tmdb'},watchlist:true}}];
 const fp=planEpgUnits({runId:'run-f',at:T,films});
 let seen=0;
 const racing=envOf(file,{onBatch:async()=>{seen++;if(seen===2)await writeFilmFacts(envOf(file),{id:FID(1),at:T,requestId:'interloper',expectedRevision:0,film:{contractVersion:1,originalTitle:'Z',source:'tmdb'},watchlist:false});}});
 const out=await applyEpgUnits(racing,{plan:fp,now:()=>T});
 assert.equal(out.counts.failed,1);
 const rec=await reconcileEpgRun(envOf(file),{plan:planEpgPersonUnits({runId:'run-f',at:T}),filmPlan:fp,now:()=>iso(61000)});
 assert.equal(rec.considered,1);assert.deepEqual([receipts(file)[0].operation,receipts(file)[0].state,receipts(file)[0].applied_revision],['film_facts','applied',2]);
 assert.equal(one(file,"SELECT original_title FROM film WHERE id='"+FID(1)+"'"),'A');
}
// 9f. The per-call ceiling: a huge limit visits at most the hard ceiling, a zero limit one unit, the default 25 (absent Persons cost reads only).
{
 const file=database('open');
 const absent=Array.from({length:60},(_,i)=>({id:PID(1000+i),state:state('X')}));
 const big=planEpgPersonUnits({runId:'run-c',at:T,persons:absent});
 const [a,b,c]=[await applyEpgPersonUnits(envOf(file),{plan:big,limit:1000}),await applyEpgPersonUnits(envOf(file),{plan:big,limit:0}),await applyEpgPersonUnits(envOf(file),{plan:big})];
 assert.deepEqual([a.cursor,a.done,a.counts.absent],[EPG_UNIT_HARD_CAP,false,EPG_UNIT_HARD_CAP]);
 assert.deepEqual([b.cursor,c.cursor],[1,25]);
 const rest=await applyEpgPersonUnits(envOf(file),{plan:big,cursor:a.cursor,limit:1000});
 assert.deepEqual([rest.cursor,rest.done],[60,true]);
}

// 9g. Three review findings. (a) A Film that disappears AFTER the writer's last read and BEFORE its batch is never recreated: the batch itself asserts the Film exists (`requireExisting`), the whole batch (receipt included) rolls back. (b) The
// combined reconcile refuses plans of two different runs (and malformed plan metadata) before any read or write. (c) A transient read failure while re-validating after a revision change never abandons the receipt; a later pass settles it.
{
 // (a) the last interleaving: the hook fires at the writer batch itself, after every planner read.
 const file=database('open');
 seedPersons(file,[2]);seedFilm(file,1);
 const p=planEpgPersonUnits({runId:'run-g',at:T,credits:[{filmId:FID(1),credits:[{personId:PID(2),role:'actor'}]}]});
 const vanishing=envOf(file,{onBatch:async statements=>{if(statements.some(item=>/^INSERT INTO film \(id,contract_version/.test(item.text)))assert.equal(sqlite(file,"DELETE FROM film WHERE id='"+FID(1)+"'").status,0);}});
 const out=await applyEpgPersonUnits(vanishing,{plan:p,now:()=>T});
 assert.deepEqual([out.counts.failed,out.counts.applied,out.failures],[1,0,[{id:FID(1),code:'film_person_precondition'}]],'the in-batch assertion refuses');
 assert.equal(one(file,"SELECT COUNT(*) FROM film WHERE id='"+FID(1)+"'"),0,'the vanished Film is not recreated by the credit producer');
 assert.equal(one(file,"SELECT COUNT(*) FROM film_person_credit"),0,'no credit written');
 assert.equal(revision(file,'film',FID(1)),0,'no revision bump');
 assert.notEqual(receipts(file)[0].state,'applied','the receipt is not falsely applied');
 assert.ok(receipts(file)[0].applied_revision==null);
 await reconcileEpgRun(envOf(file),{plan:p,now:()=>iso(3600000)});
 assert.equal(one(file,"SELECT COUNT(*) FROM film WHERE id='"+FID(1)+"'"),0,'nor by a later reconcile');
 // The shared writer option itself: with it a missing Film fails atomically, without it behaviour is unchanged (the upsert creates), anything but true is refused.
 const f2=database('open');
 const base={id:FID(9),expectedRevision:0,at:T,film:{contractVersion:1,originalTitle:'N'}};
 await assert.rejects(()=>mutateFilm(envOf(f2),{...base,requireExisting:true}),code('film_person_precondition'));
 assert.equal(one(f2,"SELECT COUNT(*) FROM film"),0);assert.equal(revision(f2,'film',FID(9)),0);
 await assert.rejects(()=>mutateFilm(envOf(f2),{...base,requireExisting:'yes'}),code('film_person_invalid'));
 await mutateFilm(envOf(f2),base);
 assert.equal(one(f2,"SELECT COUNT(*) FROM film"),1,'without the option the writer still creates the Film');
 const f3=database('open');seedFilm(f3,9);
 await mutateFilm(envOf(f3),{...base,requireExisting:true});
 assert.equal(revision(f3,'film',FID(9)),1,'with the option an existing Film is written');
}
{
 // (b) same run works; a different run is refused with no batch, no receipt change, whatever is due.
 const file=database('open');
 const fp=planEpgUnits({runId:'run-old',at:T,films:[{id:FID(1),facts:{film:{contractVersion:1,originalTitle:'A',source:'tmdb'},watchlist:true}}]});
 let seen=0;
 const racing=envOf(file,{onBatch:async()=>{seen++;if(seen===2)await writeFilmFacts(envOf(file),{id:FID(1),at:T,requestId:'interloper',expectedRevision:0,film:{contractVersion:1,originalTitle:'Z',source:'tmdb'},watchlist:false});}});
 assert.equal((await applyEpgUnits(racing,{plan:fp,now:()=>T})).counts.failed,1);
 const before=dump(file);
 const probe=envOf(file);
 const newer=planEpgPersonUnits({runId:'run-new',at:T});
 await assert.rejects(()=>reconcileEpgRun(probe,{plan:newer,filmPlan:fp,now:()=>iso(61000)}),code('film_person_run_mismatch'));
 assert.deepEqual([probe.DB.calls.batches,probe.DB.calls.queries],[0,0],'refused before any read or write');
 assert.equal(dump(file),before);assert.equal(receipts(file)[0].state,'failed');
 for(const bad of [{event:5,units:[]},{units:[]},{event:'',units:[]},'epg:x',[]]){
  await assert.rejects(()=>reconcileEpgRun(probe,{plan:bad,now:()=>iso(61000)}),code('film_person_invalid'));
  await assert.rejects(()=>reconcileEpgRun(probe,{filmPlan:bad,now:()=>iso(61000)}),code('film_person_invalid'));
 }
 assert.equal(probe.DB.calls.queries,0);
 const same=await reconcileEpgRun(envOf(file),{plan:planEpgPersonUnits({runId:'run-old',at:T}),filmPlan:fp,now:()=>iso(61000)});
 assert.equal(same.considered,1);assert.equal(receipts(file)[0].state,'applied','the same run still settles its own receipt');
}
for(const kind of ['person','credits']){
 // (c) a transient read failure is not a terminal stale verdict.
 const build=()=>{
  const file=database('open');
  seedPersons(file,[1,2]);seedFilm(file,1);
  const p=kind==='person'?planEpgPersonUnits({runId:'run-t',at:T,persons:[{id:PID(1),state:state('A')}]}):planEpgPersonUnits({runId:'run-t',at:T,credits:[{filmId:FID(1),credits:[{personId:PID(2),role:'actor'}]}]});
  const move=()=>kind==='person'
   ?recordPersonState(envOf(file),{id:PID(1),expectedRevision:0,at:T,requestId:'interloper',person:state('Z')})
   :mutateFilm(envOf(file),{id:FID(1),expectedRevision:0,at:T,film:{contractVersion:2},credits:{upsert:[{personId:PID(1),role:'director'}]}});
  return {file,p,move};
 };
 const reads=kind==='person'?/SELECT 1 AS x FROM person WHERE id=/:/SELECT contract_version FROM film WHERE id=/;
 for(const failOn of [1,2]){
  // failOn 1: the readback read fails (the receipt waits); 2: the re-validation read fails (the receipt is unsettled). Neither abandons it.
  const {file,p,move}=build();
  let step=0;
  const racing=envOf(file,{onBatch:async()=>{step++;if(step===2)await move();}});
  await applyEpgPersonUnits(racing,{plan:p,now:()=>T});
  assert.equal(receipts(file)[0].state,'failed');
  let seen=0;
  const flaky=envOf(file,{onQuery:async text=>{if(reads.test(text)&&++seen===failOn)throw new Error('D1_ERROR: network connection lost');}});
  const bad=await reconcileEpgRun(flaky,{plan:p,now:()=>iso(61000)});
  assert.equal(bad.abandoned.length,0,kind+' '+failOn+': a transient failure never abandons: '+JSON.stringify(bad));
  assert.equal(receipts(file)[0].state,'failed');assert.equal(receipts(file)[0].attempts,1,'the receipt is untouched');
  assert.equal(bad.waiting.length+bad.failed.length,1,'recorded as waiting or unsettled');
  const good=await reconcileEpgRun(envOf(file),{plan:p,now:()=>iso(121000)});
  assert.equal(good.considered,1);
  assert.deepEqual([receipts(file)[0].state,receipts(file)[0].attempts],['applied',2],kind+' '+failOn+': a later pass settles it: '+JSON.stringify(good));
 }
 // A genuine refusal is still a stale verdict, and a read failure through the spec itself propagates.
 const {file,p}=build();
 const unit=p.units[0];
 const digest=await unitDigest(unit.kind,unit.input);
 const receipt={requestId:'epg:'+unit.kind+':'+digest,contentDigest:digest,target:{kind:kind==='person'?'person':'film',id:unit.id},operation:unit.kind};
 const spec=A.unitOperation(unit.kind,{replan:async()=>unit.input});
 assert.equal(await spec.revalidate(envOf(file),receipt),'proceed');
 await assert.rejects(()=>spec.revalidate(envOf(file,{onQuery:async()=>{throw new Error('D1_ERROR: boom');}}),receipt),/boom/);
 if(kind==='credits'){
  assert.equal(sqlite(file,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('"+FID(1)+"','"+FID(2)+"','"+U+"')").status,1,'redirect target must exist');
  seedFilm(file,2);
  assert.equal(sqlite(file,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('"+FID(1)+"','"+FID(2)+"','"+U+"')").status,0);
  assert.equal(await spec.revalidate(envOf(file),receipt),'stale','a redirected Film is a content refusal: stale');
 }
}

// 10. Static: dormant. Nothing in src imports the two modules, build.mjs and the Worker do not name them, the EPG layer imports only the adapters and the authority helpers, no network, timer, cron or R2 API, no SQL that changes a table; the
// adapters import the existing fenced writers and write nothing themselves; readiness stays truthful (no operation registered, epg_commit unwired).
{
 const selfs=['src/canonical-epg-person-producer.js','src/canonical-person-adapters.js'];
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&!selfs.includes(full)){const text=fs.readFileSync(full,'utf8');if(/canonical-epg-person-producer|canonical-person-adapters/.test(text))importers.push(full);}}};
 walk('src');
 assert.deepEqual(importers.filter(file=>file!=='src/canonical-epg-person-producer.js'),[],'nothing in src imports them');
 for(const file of ['build.mjs','package.json','wrangler.toml','wrangler.jsonc'])if(fs.existsSync(file))assert.ok(!/canonical-epg-person-producer|canonical-person-adapters/.test(fs.readFileSync(file,'utf8')),file+' does not bundle them');
 const text=name=>fs.readFileSync(path.join(SRC,name),'utf8');
 const strip=value=>value.replace(/\/\/.*$/gm,'');
 const epg=text('canonical-epg-person-producer.js'),adapters=text('canonical-person-adapters.js');
 assert.deepEqual([...epg.matchAll(/from '(\.\/[^']+)'/g)].map(match=>match[1]).sort(),['./canonical-epg-producer.js','./canonical-person-adapters.js','./canonical-producer-adapters.js','./film-person-authority.js']);
 assert.deepEqual([...adapters.matchAll(/from '(\.\/[^']+)'/g)].map(match=>match[1]).sort(),['./canonical-mutations.js','./canonical-person-state.js','./canonical-producer-adapters.js','./canonical-producers.js','./canonical-receipts.js','./film-person-authority.js']);
 for(const body of [strip(epg),strip(adapters)]){
  assert.ok(!/\b(fetch|setTimeout|setInterval|scheduled|R2|BUCKET|waitUntil)\b/.test(body),'no network, timer, cron or R2 reference');
  assert.ok(!/\b(INSERT|UPDATE|DELETE|REPLACE)\b\s+(INTO|FROM)?\s*\w/.test(body),'no write SQL of its own: the canonical writes are the fenced writers');
 }
 assert.ok(/recordPersonState\(/.test(adapters)&&/mutateFilm\(/.test(adapters)&&/receiptMark/.test(adapters),'the writes are the existing writers with the receipt tail');
 assert.ok(!fs.readFileSync('src/worker.js','utf8').includes('canonical-epg-person-producer'),'the Worker does not name it');
 assert.equal(PRODUCER_OPERATIONS.size,0,'no receipt operation is registered by this change');
 const epgWiring=PRODUCER_WIRING.find(item=>item.name==='epg_commit');
 assert.ok(epgWiring.requires.some(kind=>!PRODUCER_OPERATIONS.has(kind)),'epg_commit stays unwired (producer_not_wired:epg_commit remains a blocker)');
 const readiness=await handoffReadiness(envOf(database('prepared')),{now:T});
 assert.ok(readiness.blockers.includes('producer_not_wired:epg_commit')&&readiness.ready===false);
}
console.log('canonical-epg-person-producer: ok');
