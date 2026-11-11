// AIR-374 P2b: the fenced Person-state and localization-conflict writers (src/canonical-person-state.js), dormant. Fenced path refuses before `open`; request-id replay,
// unknown outcome by readback, revision conflict, statement cap, fence loss; an owner or reviewed localization survives an automatic write and a refresh; the rows
// equal the projector's (src/canonical-repository.js savePerson/saveFilm) on shared fixtures; identity, credits and other aliases are untouched; the module is
// unimported and unbundled. sqlite3-CLI D1 stand-in only: no Worker, R2, D1 or Cloudflare access. CANON_PERSON_STATE_SOURCE points the file at a mutant
// (tests/canonical-person-state-mutation.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {createCanonicalRepository} from '../src/canonical-repository.js';
import {mutateFilm,mutatePerson,MUTATION_STATEMENT_CAP} from '../src/canonical-mutations.js';
import {planPersonState as planPersonCall,planLocalizationConflicts as planConflictCall,dispatch,readback,writerRoute,GAPS} from '../src/canonical-producers.js';

const M=await import(process.env.CANON_PERSON_STATE_SOURCE?pathToFileURL(path.resolve(process.env.CANON_PERSON_STATE_SOURCE)).href:'../src/canonical-person-state.js');
const {recordPersonState,recordLocalizationConflicts,planPersonState,planConflicts,guardReviewed,replacesStored,reviewedWrite,heldReason,upsertOverwrites,conflictParams,dimensionParams}=M;

// CANON_PERSON_STATE_ONLY=3,4 runs only those numbered sections (the mutation check runs each mutant against the sections that must kill it).
const only=process.env.CANON_PERSON_STATE_ONLY?new Set(process.env.CANON_PERSON_STATE_ONLY.split(',')):null;
const on=number=>!only||only.has(String(number));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-person-state-'));
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>name.replace(/\.sql$/,''));
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const sql=name=>fs.readFileSync('migrations/'+name+'.sql','utf8');
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
// One migrated template, copied per scenario (a file copy, not a migration run).
const template=path.join(root,'template.sqlite');
assert.equal(sqlite(template,chain.map(sql).join('\n')).status,0);
let n=0;
function database(stage='open'){
 const file=path.join(root,'ps-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 if(['prepared','open','held'].includes(stage))assert.equal(sqlite(file,VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1").status,0);
 if(stage==='open'||stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1").status,0);
 if(stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);
 return file;
}
const T='2026-11-07T10:00:00.000Z',T2='2026-11-08T10:00:00.000Z';
const ID='person:director/1';
const envOf=(file,options)=>({DB:d1Standin(file,options)});
const code=expected=>error=>error.code===expected;
const dim=(slot,over={})=>({dimension:slot,status:'resolved',updatedAt:T,source:'letterboxd',sourceVersion:'director/1',provenance:{scope:'role'},nextAction:'stop',...over});
const loc=(over={})=>({dimension:'localization',status:'provisional',updatedAt:T2,source:'wikidata',sourceVersion:'provisional',provenance:{value:'Новое'},value:'Новое',nextAction:'keep_provisional',...over});
const identity=dim('identity');
const reviewed=(value,authority,over={})=>loc({status:'reviewed',source:authority,sourceVersion:authority,value,provenance:{authority,value},nextAction:'keep_reviewed',...over});
const q=value=>value==null?'NULL':"'"+String(value).replace(/'/g,"''")+"'";
function seedPerson(file,stored,staleIdentity=false){
 sqlite(file,`INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('${ID}','director/1',1,'${T}');`);
 if(staleIdentity)sqlite(file,`INSERT INTO person_dimension (person_id,dimension,status,source,attempts,next_action,updated_at) VALUES ('${ID}','identity','pending','old',3,'retry','2026-01-01T00:00:00.000Z');`);
 if(stored){
  const s=stored;
  sqlite(file,`INSERT INTO person_dimension (person_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ('${ID}','localization',${q(s.status)},${q(s.source)},${q(s.sourceVersion)},${q(JSON.stringify(s.provenance))},${q(s.value)},${q(s.provenance?.authority??null)},0,'keep',${q(s.updatedAt||T)});`);
 }
}
const dump=file=>JSON.stringify({dimension:rows(file,"SELECT dimension,status,source,source_version,provenance_json,value,authority,last_error,failure_reason,retry_at,attempts,next_action,updated_at FROM person_dimension WHERE person_id='"+ID+"' ORDER BY dimension"),alias:rows(file,"SELECT kind,value,provenance_json FROM person_alias WHERE person_id='"+ID+"' ORDER BY kind,value"),conflict:rows(file,"SELECT * FROM localization_conflict ORDER BY id")});
const revision=(file,kind,id)=>Number(one(file,"SELECT revision FROM canonical_revision WHERE kind='"+kind+"' AND id='"+id+"'")??0);
// The projector on its own database copy: the repository over the stand-in, writes applied one after another (no failure is injected here).
const repoOf=file=>{const db=d1Standin(file);return createCanonicalRepository({get:(s,p=[])=>db.prepare(s).bind(...p).first(),all:async(s,p=[])=>(await db.prepare(s).bind(...p).all()).results,run:async(s,p=[])=>{await db.prepare(s).bind(...p).run();},transaction:fn=>fn()});};
const projectorPerson=(localization,extra={})=>({id:ID,roleId:'director/1',contractVersion:1,externalIds:[],aliases:[],identity,localization,localizationConflicts:[],...extra});

// 1. Pure rules, moved from the projector.
if(on(1)){
 const owner={dimension:'localization',status:'reviewed',authority:'owner',value:'Own',updated_at:T,provenance_json:'{"authority":"owner"}',source:'owner'};
 const dict={dimension:'localization',status:'reviewed',authority:'dictionary',value:'Dict',updated_at:T,provenance_json:'{"authority":"dictionary"}',source:'dictionary'};
 assert.equal(replacesStored(owner,reviewed('X','dictionary')),false,'a dictionary review does not replace an owner value');
 assert.equal(replacesStored(owner,reviewed('X','owner')),true);
 assert.equal(replacesStored(dict,loc()),false,'an automatic value does not replace a reviewed one');
 assert.equal(replacesStored(dict,reviewed('X','dictionary')),true);
 assert.equal(reviewedWrite(reviewed('X','owner')),true);
 assert.equal(reviewedWrite(loc({status:'reviewed',source:'wikidata',sourceVersion:'v',provenance:{}})),false);
 assert.equal(reviewedWrite(loc({source:'dictionary',provenance:{authority:'dictionary'}})),false,'a provisional state is never a review');
 const kept=guardReviewed({localization:loc(),aliases:[]},owner,'name');
 assert.equal(kept.localization.value,'Own');
 assert.deepEqual(kept.localizationConflicts.map(item=>[item.reason,item.value]),[['owner_kept','Новое']]);
 assert.deepEqual(kept.aliases.map(item=>item.value),['Новое']);
 assert.equal(guardReviewed({localization:loc(),aliases:[]},dict,'name').localizationConflicts[0].reason,'reviewed_kept');
 const free={localization:loc()};
 assert.equal(guardReviewed(free,{...dict,status:'provisional'},'name'),free,'nothing is held without a reviewed stored value');
 assert.equal(guardReviewed(free,null,'name'),free);
 assert.equal(upsertOverwrites(dict,dimensionParams(ID,loc(),'localization')),false);
 assert.equal(upsertOverwrites(owner,dimensionParams(ID,reviewed('Z','dictionary'),'localization')),false);
 assert.equal(upsertOverwrites(owner,dimensionParams(ID,reviewed('Z','owner'),'localization')),true);
 assert.equal(heldReason(owner,loc()),'owner_kept');
 assert.equal(heldReason(dict,loc()),'reviewed_kept');
 assert.equal(heldReason(dict,loc({value:'Dict'})),null);
 assert.equal(heldReason(null,loc()),null);
 assert.throws(()=>dimensionParams(ID,{status:'resolved'},'identity'),code('film_person_invalid'));
 assert.throws(()=>dimensionParams(ID,dim('identity'),'localization'),code('film_person_invalid'),'a state names its own slot');
 assert.throws(()=>conflictParams('person',ID,{value:'v',reason:'x'}),code('film_person_invalid'));
 assert.throws(()=>planConflicts('film','person:x',[{reason:'r',at:T}]),code('film_person_invalid'));
 assert.equal(planConflicts('person',ID,[{value:'a',reason:'r',at:T},{value:'a',reason:'r',at:T2}]).length,1,'a repeated conflict id is one row');
 assert.throws(()=>planPersonState({id:ID,person:{}},null),code('film_person_invalid'));
}

// 2. Marker matrix: only `open` writes; every other state refuses before a statement reaches the database.
if(on(2)){
 const input={id:ID,expectedRevision:0,at:T,requestId:'r1',person:{identity,localization:loc()}};
 const conflicts={kind:'person',id:ID,expectedRevision:0,at:T,requestId:'r2',conflicts:[{value:'v',reason:'owner_kept',at:T}]};
 for(const [stage,expected] of [['r2','film_person_not_open'],['prepared','film_person_not_open'],['held','film_person_held']]){
  const file=database(stage);seedPerson(file);
  const env=envOf(file),before=dump(file);
  for(const [call,arg] of [[recordPersonState,input],[recordLocalizationConflicts,conflicts]]){
   await assert.rejects(()=>call(env,arg),code(expected),stage);
  }
  assert.equal(env.DB.calls.batches,0,stage+': no batch');
  assert.equal(dump(file),before,stage+': nothing written');
  assert.equal(one(file,'SELECT COUNT(*) FROM canonical_revision'),0,stage+': no revision');
 }
 const open=database('open');seedPerson(open);
 const env=envOf(open);
 assert.deepEqual(await recordPersonState(env,input),{id:ID,revision:1,already:false,requestId:'r1'});
 assert.equal(one(open,"SELECT value FROM person_dimension WHERE dimension='localization'"),'Новое');
 const legacy=path.join(root,'legacy.sqlite');assert.equal(sqlite(legacy,chain.filter(name=>name<'0013').map(sql).join('\n')).status,0);
 await assert.rejects(()=>recordPersonState(envOf(legacy),input),code('film_person_not_open'),'legacy is not writable');
 await assert.rejects(()=>recordPersonState(envOf(open),{...input,expectedRevision:-1}),code('film_person_invalid'));
 await assert.rejects(()=>recordPersonState(envOf(open),{...input,requestId:''}),code('film_person_invalid'));
 await assert.rejects(()=>recordPersonState(envOf(open),{id:'film:x',expectedRevision:0,at:T,requestId:'r',person:{identity}}),code('film_person_invalid'));
 const none=database('open');
 await assert.rejects(()=>recordPersonState(envOf(none),input),code('film_person_reference'),'the Person must exist');
}

// 3. Equivalence with the projector on shared fixtures: the same stored state and the same input give the same dimension, alias and conflict rows.
if(on(3)){
 const FIXTURES=[
  ['fresh Person',null,loc()],
  ['provisional replaced by provisional',loc({value:'Старое',provenance:{value:'Старое'}}),loc()],
  ['reviewed dictionary kept against automatic',reviewed('Словарь','dictionary'),loc()],
  ['owner kept against a dictionary review',reviewed('Владелец','owner'),reviewed('Словарь2','dictionary')],
  ['owner replaced by an owner review',reviewed('Владелец','owner'),reviewed('Владелец2','owner')],
  ['dictionary replaced by a dictionary review',reviewed('Словарь','dictionary'),reviewed('Словарь3','dictionary')],
  ['reviewed review with no authority in its provenance (SQL guard keeps it)',reviewed('Словарь','dictionary'),loc({status:'reviewed',source:'other',sourceVersion:'dictionary',provenance:{value:'Иное'},value:'Иное'})],
  ['same value as the reviewed one',reviewed('Словарь','dictionary'),loc({value:'Словарь',provenance:{value:'Словарь'}})],
  ['a domain conflict carried by the input',loc({value:'Старое',provenance:{value:'Старое'}}),loc(),{localizationConflicts:[{value:'Чужое',source:'wikidata',provenance:{x:1},at:T2,reason:'untrusted_review'}]}],
  ['owner kept and a domain conflict',reviewed('Владелец','owner'),loc(),{localizationConflicts:[{value:'Чужое',source:'tmdb',provenance:null,at:T2,reason:'untrusted_review'}]}],
 ];
 for(const [name,stored,incoming,extra] of FIXTURES){
  const a=database('r2'),b=database('open');
  seedPerson(a,stored,name!=='fresh Person');seedPerson(b,stored,name!=='fresh Person');
  const repo=repoOf(a),env=envOf(b);
  for(const round of [1,2]){
   await repo.savePerson({person:projectorPerson(incoming,extra)});
   const result=await recordPersonState(env,{id:ID,expectedRevision:revision(b,'person',ID),at:T2,requestId:'req-'+round,person:{identity,localization:incoming,localizationConflicts:extra?.localizationConflicts}});
   assert.equal(dump(b),dump(a),name+' (round '+round+')');
   if(round===2)assert.equal(result.already,true,name+': the refresh is a replay');
  }
 }
}

// 4. An owner or reviewed localization survives an automatic write and a refresh; only a held alias and a conflict are added.
if(on(4)){
 const file=database('open');seedPerson(file,reviewed('Владелец','owner'));
 sqlite(file,"INSERT INTO person_alias (person_id,kind,value) VALUES ('"+ID+"','name','Заметка'); INSERT INTO person_external_id (person_id,scheme,value,trusted,conflicting) VALUES ('"+ID+"','letterboxd-role','director/1',1,0); INSERT INTO film (id,contract_version,updated_at) VALUES ('film:x',1,'t'); INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES ('film:x','"+ID+"','director',0)");
 const untouched=()=>JSON.stringify([rows(file,'SELECT * FROM person'),rows(file,'SELECT * FROM person_external_id'),rows(file,'SELECT * FROM film_person_credit'),rows(file,"SELECT * FROM person_alias WHERE value='Заметка'"),rows(file,'SELECT * FROM film')]);
 const before=untouched();
 const env=envOf(file);
 for(const attempt of [1,2,3]){
  await recordPersonState(env,{id:ID,expectedRevision:revision(file,'person',ID),at:T2,requestId:'a'+attempt,person:{identity,localization:loc({value:'Автомат '+(attempt>1?'1':'1')})}});
  assert.deepEqual(rows(file,"SELECT status,authority,value FROM person_dimension WHERE dimension='localization'"),[{status:'reviewed',authority:'owner',value:'Владелец'}],'the owner value stands (attempt '+attempt+')');
 }
 assert.equal(one(file,"SELECT COUNT(*) FROM localization_conflict WHERE reason='owner_kept' AND value='Автомат 1'"),1,'one conflict, however often it is refreshed');
 assert.equal(one(file,"SELECT COUNT(*) FROM person_alias WHERE value='Автомат 1'"),1);
 assert.equal(untouched(),before,'the person row, external ids, credits, other aliases and Films are untouched');
 // A reviewed dictionary value is replaced by the owner only through an owner review.
 await recordPersonState(env,{id:ID,expectedRevision:revision(file,'person',ID),at:T2,requestId:'o',person:{localization:reviewed('Владелец-2','owner',{updatedAt:T2})}});
 assert.equal(one(file,"SELECT value FROM person_dimension WHERE dimension='localization'"),'Владелец-2');
 await recordPersonState(env,{id:ID,expectedRevision:revision(file,'person',ID),at:T2,requestId:'d',person:{localization:reviewed('Словарь-X','dictionary',{updatedAt:T2})}});
 assert.equal(one(file,"SELECT value FROM person_dimension WHERE dimension='localization'"),'Владелец-2','a dictionary review never replaces an owner value');
 // Without an identity the existing identity row is left alone.
 const withId=database('open');seedPerson(withId);
 await recordPersonState(envOf(withId),{id:ID,expectedRevision:0,at:T,requestId:'i',person:{identity}});
 await recordPersonState(envOf(withId),{id:ID,expectedRevision:1,at:T2,requestId:'l',person:{localization:loc()}});
 assert.deepEqual(rows(withId,'SELECT dimension FROM person_dimension ORDER BY dimension').map(row=>row.dimension),['identity','localization']);
}

// 5. Request-id replay, revision conflict, statement cap, fence loss, unknown outcome.
if(on(5)){
 const file=database('open');seedPerson(file);
 const env=envOf(file);
 const input={id:ID,expectedRevision:0,at:T,requestId:'same',person:{identity,localization:loc(),localizationConflicts:[{value:'c',source:'s',at:T,reason:'untrusted_review'}]}};
 const first=await recordPersonState(env,input);
 assert.deepEqual([first.already,first.revision],[false,1]);
 const batches=env.DB.calls.batches,state=dump(file);
 const replay=await recordPersonState(env,input);
 assert.deepEqual([replay.already,replay.revision],[true,1],'a replay returns the current revision');
 assert.equal(env.DB.calls.batches,batches,'a replay opens no batch');
 assert.equal(dump(file),state);
 assert.equal(revision(file,'person',ID),1,'a replay does not bump the revision');
 // A competing change with another value and the stale revision: a retryable conflict, nothing written.
 await assert.rejects(()=>recordPersonState(env,{...input,requestId:'other',person:{localization:loc({value:'Другое',provenance:{value:'Другое'}})}}),code('film_person_revision_conflict'));
 assert.equal(dump(file),state);
 // The statement cap refuses before any statement.
 const many=Array.from({length:MUTATION_STATEMENT_CAP+10},(_,index)=>({value:'v'+index,reason:'r',at:T}));
 const cap=envOf(file);
 await assert.rejects(()=>recordLocalizationConflicts(cap,{kind:'person',id:ID,expectedRevision:1,at:T,requestId:'cap',conflicts:many}),code('film_person_bounded'));
 assert.equal(cap.DB.calls.batches,0);
 await assert.rejects(()=>recordPersonState(cap,{...input,expectedRevision:1,requestId:'cap2',person:{localization:loc({value:'Z',provenance:{value:'Z'}}),localizationConflicts:many}}),code('film_person_bounded'));
 // The marker moves between the read and the batch: the whole batch fails on its fence.
 const moved=database('open');seedPerson(moved);
 const lose=envOf(moved,{onBatch:()=>{sqlite(moved,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");}});
 await assert.rejects(()=>recordPersonState(lose,{...input,requestId:'f'}),code('film_person_fence'));
 assert.equal(one(moved,'SELECT COUNT(*) FROM person_dimension'),0);
 assert.equal(one(moved,'SELECT COUNT(*) FROM canonical_revision'),0);
 // Unknown outcome: the batch applied but the answer was lost. dispatch reports it, readback names the replay, the replay is a no-op.
 const lost=database('open');seedPerson(lost);
 const real=d1Standin(lost);
 const lossy={DB:{...real,batch:async statements=>{await real.batch(statements);throw new Error('network lost');}}};
 const plan=planPersonCall({id:ID,revision:0,at:T,requestId:'u1',person:{identity,localization:loc()}});
 const result=await dispatch(lossy,plan);
 assert.equal(result.results[0].status,'unknown');
 const verdict=await readback(envOf(lost),result.results[0]);
 assert.equal(verdict.outcome,'settle_by_replay');
 const settled=await dispatch(envOf(lost),plan);
 assert.deepEqual([settled.results[0].status,settled.results[0].result.already,settled.complete],['applied',true,true],'the replay finds the state in place');
 assert.equal(revision(lost,'person',ID),1,'applied exactly once');
 // A replay is recognised only while every row is still there: a deleted conflict is restored, not skipped.
 sqlite(file,"DELETE FROM localization_conflict");
 const restored=await recordPersonState(env,{...input,expectedRevision:1});
 assert.deepEqual([restored.already,restored.revision],[false,2]);
 assert.equal(one(file,'SELECT COUNT(*) FROM localization_conflict'),1);
 // The owner review lands between the snapshot and the batch (it writes the dimension without this writer's revision): the in-batch guards still hold.
 for(const [name,incoming,expectedValue] of [['automatic',loc({value:'Автомат',provenance:{value:'Автомат'}}),'Гонка'],['dictionary',reviewed('Словарь-гонка','dictionary'),'Гонка']]){
  const race=database('open');seedPerson(race);
  const raced=envOf(race,{onBatch:()=>{sqlite(race,`INSERT INTO person_dimension (person_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,next_action,updated_at) VALUES ('${ID}','localization','reviewed','owner','owner','{"authority":"owner"}','Гонка','owner',0,'keep','${T}')`);}});
  await recordPersonState(raced,{id:ID,expectedRevision:0,at:T2,requestId:'race',person:{identity,localization:incoming}});
  assert.deepEqual(rows(race,"SELECT status,authority,value FROM person_dimension WHERE dimension='localization'"),[{status:'reviewed',authority:'owner',value:expectedValue}],'the raced owner value stands against '+name);
  assert.equal(one(race,"SELECT COUNT(*) FROM localization_conflict WHERE reason='owner_kept' AND value='"+incoming.value+"'"),1,'the held value is recorded in the batch ('+name+')');
  assert.equal(one(race,"SELECT COUNT(*) FROM person_alias WHERE value='"+incoming.value+"'"),1);
 }
 // The Person disappears between the read and the batch: the batch proves it still exists.
 const gone=database('open');seedPerson(gone);
 await assert.rejects(()=>recordPersonState(envOf(gone,{onBatch:()=>{sqlite(gone,"DELETE FROM person");}}),{...input,requestId:'g'}),code('film_person_precondition'));
 assert.equal(one(gone,'SELECT COUNT(*) FROM person_dimension'),0);
 // An unknown outcome that did NOT apply: the replay applies it once.
 const dropped=database('open');seedPerson(dropped);
 const real2=d1Standin(dropped);
 const lossy2={DB:{...real2,batch:async()=>{throw new Error('network lost');}}};
 const plan2=planPersonCall({id:ID,revision:0,at:T,requestId:'u2',person:{identity,localization:loc()}});
 assert.equal((await dispatch(lossy2,plan2)).results[0].status,'unknown');
 assert.equal(one(dropped,'SELECT COUNT(*) FROM person_dimension'),0);
 assert.equal((await dispatch(envOf(dropped),plan2)).results[0].result.already,false);
 assert.equal(revision(dropped,'person',ID),1);
}

// 6. Localization conflicts outside a merge: recorded as the projector records them, a repeat is a no-op, nothing is cleared, Film and Person.
if(on(6)){
 const film={id:'film:tmdb:5',contractVersion:1,canonicalIdentity:null,originalTitle:'T',externalIds:[],aliases:[],identity:dim('identity'),metadata:dim('metadata'),fingerprint:dim('fingerprint'),prediction:dim('prediction'),localization:loc({updatedAt:T}),localizationConflicts:[{value:'Чужое',source:'tmdb',provenance:{a:1},at:T2,reason:'untrusted_review'},{value:null,source:null,provenance:null,at:T2,reason:'no_value'}]};
 const a=database('r2'),b=database('open');
 await repoOf(a).saveFilm({film,watchlist:null});
 const env=envOf(b);
 await mutateFilm(env,{id:film.id,expectedRevision:0,at:T,film:{contractVersion:1,originalTitle:'T'}});
 const done=await recordLocalizationConflicts(env,{kind:'film',id:film.id,expectedRevision:1,at:T2,requestId:'c1',conflicts:film.localizationConflicts});
 assert.deepEqual([done.already,done.written,done.revision],[false,2,2]);
 const conflictRows=file=>JSON.stringify(rows(file,"SELECT * FROM localization_conflict ORDER BY id"));
 assert.equal(conflictRows(b),conflictRows(a),'the Film conflict rows equal the projector\'s');
 const batches=env.DB.calls.batches;
 const again=await recordLocalizationConflicts(env,{kind:'film',id:film.id,expectedRevision:2,at:T2,requestId:'c1',conflicts:film.localizationConflicts});
 assert.deepEqual([again.already,again.written,again.revision],[true,0,2]);
 assert.equal(env.DB.calls.batches,batches,'a replay opens no batch');
 // Only the new row is written when some exist; the old ones stay.
 const extra=await recordLocalizationConflicts(env,{kind:'film',id:film.id,expectedRevision:2,at:T2,requestId:'c2',conflicts:[{...film.localizationConflicts[0],at:'2030-01-01T00:00:00.000Z'},film.localizationConflicts[1],{value:'Третье',source:'x',at:T2,reason:'untrusted_review'}]});
 assert.deepEqual([extra.written,extra.revision],[1,3]);
 assert.equal(one(b,"SELECT COUNT(*) FROM localization_conflict WHERE at='2030-01-01T00:00:00.000Z'"),0,'an existing conflict row is never rewritten');
 assert.equal(one(b,'SELECT COUNT(*) FROM localization_conflict'),3);
 // Person: the same rows as the projector's person write with the same domain conflicts.
 const pa=database('r2'),pb=database('open');seedPerson(pa);seedPerson(pb);
 const domain=[{value:'Чужое',source:'wikidata',provenance:{x:1},at:T2,reason:'untrusted_review'}];
 await repoOf(pa).savePerson({person:projectorPerson(loc(),{localizationConflicts:domain})});
 await recordLocalizationConflicts(envOf(pb),{kind:'person',id:ID,expectedRevision:0,at:T2,requestId:'p1',conflicts:domain});
 assert.equal(conflictRows(pb),conflictRows(pa));
 // Refusals: a redirected or missing Film, a missing Person, a stale revision, an empty list. Nothing is written by a refusal.
 const guard=database('open');seedPerson(guard);
 sqlite(guard,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:a',1,'t'),('film:b',1,'t');INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:a','film:b','t')");
 const genv=envOf(guard);
 const base={kind:'film',expectedRevision:0,at:T,requestId:'g',conflicts:[{value:'v',reason:'r',at:T}]};
 await assert.rejects(()=>recordLocalizationConflicts(genv,{...base,id:'film:a'}),code('film_person_redirect'));
 await assert.rejects(()=>recordLocalizationConflicts(genv,{...base,id:'film:zzz'}),code('film_person_reference'));
 await assert.rejects(()=>recordLocalizationConflicts(genv,{...base,kind:'person',id:'person:zzz'}),code('film_person_reference'));
 await assert.rejects(()=>recordLocalizationConflicts(genv,{...base,id:'film:b',expectedRevision:4}),code('film_person_revision_conflict'));
 await assert.rejects(()=>recordLocalizationConflicts(genv,{...base,id:'film:b',conflicts:[]}),code('film_person_invalid'));
 await assert.rejects(()=>recordLocalizationConflicts(genv,{...base,id:ID}),code('film_person_invalid'),'the kind names the id');
 assert.equal(one(guard,'SELECT COUNT(*) FROM localization_conflict'),0);
 assert.equal(genv.DB.calls.batches,1,'only the stale revision reached a batch (and failed whole)');
 // A person write does not clear conflicts: a refresh adds, never removes.
 await recordPersonState(envOf(pb),{id:ID,expectedRevision:revision(pb,'person',ID),at:T2,requestId:'p2',person:{localization:reviewed('Словарь','dictionary')}});
 assert.equal(one(pb,'SELECT COUNT(*) FROM localization_conflict'),1,'nothing clears a conflict outside a merge');
}

// 7. Producer registration: the planners validate, dispatch is dormant before `open`, and the readiness gaps stay until the differential harness (P6).
if(on(7)){
 assert.deepEqual(planPersonCall({id:'film:x',at:T,requestId:'r',person:{identity}}).skipped,[{reason:'invalid_input'}]);
 assert.deepEqual(planPersonCall({id:ID,at:T,requestId:'',person:{identity}}).skipped,[{reason:'invalid_input'}]);
 assert.deepEqual(planPersonCall({id:ID,at:T,requestId:'r',person:{}}).skipped,[{reason:'invalid_input'}]);
 assert.deepEqual(planConflictCall({kind:'film',id:ID,at:T,requestId:'r',conflicts:[{}]}).skipped,[{reason:'invalid_input'}]);
 assert.equal(planConflictCall({kind:'person',id:ID,revision:3,at:T,requestId:'r',conflicts:[{value:'v',reason:'r',at:T}]}).calls[0].input.expectedRevision,3);
 const prepared=database('prepared');seedPerson(prepared);
 const env=envOf(prepared),before=dump(prepared);
 assert.equal((await writerRoute(env)).writer,'projector');
 for(const plan of [planPersonCall({id:ID,revision:0,at:T,requestId:'r',person:{identity,localization:loc()}}),planConflictCall({kind:'person',id:ID,revision:0,at:T,requestId:'r',conflicts:[{value:'v',reason:'r',at:T}]})]){
  const result=await dispatch(env,plan);
  assert.deepEqual([result.executed,result.reason],[false,'projector_is_writer']);
 }
 assert.equal(env.DB.calls.batches,0);assert.equal(dump(prepared),before);
 const open=database('open');seedPerson(open);
 const r=await dispatch(envOf(open),planConflictCall({kind:'person',id:ID,revision:0,at:T,requestId:'r',conflicts:[{value:'v',reason:'r',at:T}]}));
 assert.equal(r.results[0].status,'applied');
 const verdict=await readback(envOf(open),{fn:'recordLocalizationConflicts',input:{kind:'person',id:ID,expectedRevision:0}});
 assert.deepEqual([verdict.outcome,verdict.revision],['settle_by_replay',1]);
 assert.ok(GAPS.includes('person_dimension rows and Person localization state')&&GAPS.includes('localization_conflict rows outside a merge'),'readiness gaps are removed only by the computed P6 harness');
}

// 8. Static: dormant and scoped. Imported only by the producer routing module, not bundled, no R2/network, writes only its own tables.
if(on(8)){
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&full!=='src/canonical-person-state.js'&&fs.readFileSync(full,'utf8').includes('canonical-person-state'))importers.push(full);}};
 walk('src');
 assert.deepEqual(importers.sort(),['src/canonical-producers.js'],'only the routing module registers it');
 for(const file of ['build.mjs','package.json','wrangler.toml','wrangler.jsonc'])if(fs.existsSync(file))assert.ok(!fs.readFileSync(file,'utf8').includes('canonical-person-state'),file+' does not bundle it');
 const text=fs.readFileSync('src/canonical-person-state.js','utf8').replace(/\/\/.*$/gm,'');
 assert.ok(!/\bR2\b|fetch\(|BUCKET|\.get\(['"]/.test(text),'no R2 and no network');
 const written=new Set([...text.matchAll(/(?:INSERT INTO|DELETE FROM|UPDATE)\s+([a-z_]+)/g)].map(match=>match[1]));
 assert.deepEqual([...written].sort(),['localization_conflict','person_alias','person_dimension']);
 assert.ok(!written.has('person')&&!written.has('person_external_id')&&!written.has('film_person_credit')&&!written.has('film'),'identity, external ids and credits are not written here');
}

console.log('canonical-person-state: the fenced Person-state and conflict writers refuse before open, equal the projector\'s rows on shared fixtures, never downgrade an owner or reviewed localization, replay by content, settle unknown outcomes by replay and readback, refuse a stale revision or fence and the statement cap, touch no identity, credit or other alias, and stay dormant');
