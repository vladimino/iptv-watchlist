// AIR-374 P3a `person_mutation` (ADR 0130): the dormant Person-row unit (src/canonical-person-mutation-producer.js) and its integration with the EPG Person layer, on the sqlite3-CLI D1 stand-in. No Worker, R2, D1 or Cloudflare access.
// Covered: content and digest, the route gate (dormant below open), create and update semantics (who may create, mode existing, role collision, owner/blank/external-id protections, upsert-only), idempotency and the stable request id, the
// no-op without a receipt, the atomic receipt (a mismatch rolls the whole batch back), the interleavings (the Person appears or vanishes between the pre-plan and the batch), replay bound to the event, transient read failures, the plan order
// with credits (person_mutation first, a still missing credit Person stays film_person_reference) and the bounded own-origin reconcile. EPG_SRC points the file at a mutant copy of src/; EPG_TEMPLATE at a prebuilt template database.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const SRC=process.env.EPG_SRC?path.resolve(process.env.EPG_SRC):path.resolve('src');
const load=name=>import(pathToFileURL(path.join(SRC,name)).href);
const M=await load('canonical-person-mutation-producer.js');
const P=await load('canonical-epg-person-producer.js');
const {mutatePerson,mutateFilm}=await load('canonical-mutations.js');
const {PRODUCER_WIRING,PRODUCER_OPERATIONS,handoffReadiness}=await load('canonical-producers.js');
const {OPERATION_KINDS}=await load('canonical-receipts.js');
const R=await load('canonical-producer-run.js');
const {planEpgPersonUnitsWithRefusals}=P;
const {unitDigest}=await load('canonical-person-adapters.js');
const {planEpgPersonUnits,applyEpgPersonUnits,reconcileEpgRun,epgPersonReplan}=P;
const {applyPersonMutation,personMutationDigest,personMutationContent,personMutationOperation,planPersonMutation,PERSON_MUTATION_OPERATION,PERSON_ITEMS_PER_UNIT_MAX}=M;

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
const TABLES2=['person','person_external_id','person_alias','person_dimension','film','film_person_credit','canonical_revision','canonical_write_receipt'];
const dump2=file=>JSON.stringify(TABLES2.map(table=>[table,rows(file,'SELECT * FROM '+table+' ORDER BY 1,2,3')]));
const ext=file=>rows(file,"SELECT scheme,value,trusted,conflicting,provenance_json FROM person_external_id WHERE person_id='"+PID(1)+"' ORDER BY scheme,value");
const aliasesOf=file=>rows(file,"SELECT kind,value FROM person_alias WHERE person_id='"+PID(1)+"' ORDER BY kind,value");
const prow=(file,id=PID(1))=>rows(file,"SELECT role_id,contract_version,updated_at FROM person WHERE id='"+id+"'")[0];
const unit=(over={},person={})=>({id:PID(1),at:T,person:{roleId:'director/1',contractVersion:1,externalIds:[{scheme:'tmdb',value:'11',trusted:true},{scheme:'imdb',value:'nm1'}],aliases:[{value:'Alias One'}],...person},...over});
const OPEN={origin:'epg',event:'epg:run-1',now:()=>T};

// 1. Content and digest: a SET of external ids and aliases (sorted), trust normalized, blank and malformed refused, bounded; the id and the mode are bound, the write clock is not.
{
 assert.ok(OPERATION_KINDS.includes('person_mutation'));
 const a=await personMutationDigest(unit()),b=await personMutationDigest(unit({at:'2030-01-01T00:00:00.000Z'},{externalIds:[{scheme:'imdb',value:'nm1'},{scheme:'tmdb',value:11,trusted:true}]}));
 assert.equal(await personMutationDigest(unit({},{aliases:[{kind:'a',value:'Z'},{value:'Alias One'},{value:'B'}]})),await personMutationDigest(unit({},{aliases:[{value:'B'},{value:'Alias One'},{kind:'a',value:'Z'}]})),'alias order does not move the digest');
 assert.equal(a,b,'order, number values and the write clock do not move the digest');
 assert.notEqual(a,await personMutationDigest(unit({id:PID(2)})),'the target is bound');
 assert.notEqual(a,await personMutationDigest(unit({mode:'existing'})),'the mode is bound');
 assert.notEqual(a,await personMutationDigest(unit({},{contractVersion:2})));
 assert.notEqual(a,await personMutationDigest(unit({},{roleId:'director/9'})));
 assert.notEqual(a,await personMutationDigest(unit({},{aliases:[{value:'Other'}]})));
 assert.notEqual(a,await personMutationDigest(unit({},{externalIds:[{scheme:'tmdb',value:'11'},{scheme:'imdb',value:'nm1'}]})),'trust is content');
 assert.deepEqual(personMutationContent(unit({},{externalIds:[{scheme:'x',value:'1',trusted:true,conflicting:true}]})).externalIds[0],{scheme:'x',value:'1',trusted:false,conflicting:true,provenance:null});
 assert.deepEqual(personMutationContent(unit({},{aliases:[{value:'N'}]})).aliases,[{kind:'name',value:'N',provenance:null}]);
 const bad=[{id:FID(1)},{id:'person:'},{id:7},{mode:'create'},{person:null},{person:[]},{person:{roleId:'',contractVersion:1}},{person:{roleId:'  ',contractVersion:1}},{person:{roleId:'d/1'}},{person:{roleId:'d/1',contractVersion:0}},{person:{roleId:'d/1',contractVersion:1.5}},
  {person:{roleId:'d/1',contractVersion:1,externalIds:'x'}},{person:{roleId:'d/1',contractVersion:1,aliases:{}}},{person:{roleId:'d/1',contractVersion:1,externalIds:[{scheme:'tmdb',value:''}]}},{person:{roleId:'d/1',contractVersion:1,externalIds:[{scheme:'',value:'1'}]}},
  {person:{roleId:'d/1',contractVersion:1,externalIds:[{scheme:'tmdb',value:'1'},{scheme:'tmdb',value:1}]}},{person:{roleId:'d/1',contractVersion:1,externalIds:[null]}},{person:{roleId:'d/1',contractVersion:1,aliases:[{value:' '}]}},
  {person:{roleId:'d/1',contractVersion:1,aliases:[{value:'a'},{value:'a'}]}},{person:{roleId:'d/1',contractVersion:1,aliases:[{kind:'',value:'a'}]}}];
 for(const over of bad)assert.throws(()=>personMutationContent({...unit(),...over}),code('film_person_invalid'),JSON.stringify(over));
 assert.throws(()=>personMutationContent(null),code('film_person_invalid'));
 const many=count=>Array.from({length:count},(_,i)=>({value:'a'+i}));
 assert.equal(personMutationContent(unit({},{externalIds:[],aliases:many(PERSON_ITEMS_PER_UNIT_MAX)})).aliases.length,PERSON_ITEMS_PER_UNIT_MAX);
 assert.throws(()=>personMutationContent(unit({},{externalIds:[],aliases:many(PERSON_ITEMS_PER_UNIT_MAX+1)})),code('film_person_bounded'));
 assert.equal(personMutationContent(unit({},{externalIds:undefined,aliases:undefined})).externalIds.length,0);
}

// 2. Dormant below open: one marker read and nothing else; held throws, never a fallback.
for(const stage of ['legacy','r2','prepared']){
 const file=database(stage),env=envOf(file);
 assert.deepEqual(await applyPersonMutation(env,{...OPEN,input:unit()}),{state:'skipped',reason:'projector_is_writer',receipt:false},stage);
 assert.equal(env.DB.calls.batches,0);assert.equal(one(file,'SELECT COUNT(*) FROM person'),0);assert.equal(one(file,'SELECT COUNT(*) FROM canonical_write_receipt'),0);
}
{
 const file=database('held');
 await assert.rejects(()=>applyPersonMutation(envOf(file),{...OPEN,input:unit()}),code('film_person_held'));
 const env=envOf(file,{onQuery:async()=>{throw new Error('D1_ERROR: boom');}});
 await assert.rejects(()=>applyPersonMutation(env,{...OPEN,input:unit()}),/boom|film_person/);
 assert.equal(one(file,'SELECT COUNT(*) FROM person'),0);
}

// 3. CREATE: an absent Person is created by this unit, in ONE batch with its applied receipt; the second pass is a no-op without a receipt; the request id is stable per event, kind, target and digest.
{
 const file=database('open'),env=envOf(file);
 const out=await applyPersonMutation(env,{...OPEN,input:unit()});
 assert.equal(out.state,'applied');
 assert.deepEqual(prow(file),{role_id:'director/1',contract_version:1,updated_at:T});
 assert.deepEqual(ext(file),[{scheme:'imdb',value:'nm1',trusted:0,conflicting:0,provenance_json:null},{scheme:'tmdb',value:'11',trusted:1,conflicting:0,provenance_json:null}]);
 assert.deepEqual(aliasesOf(file),[{kind:'name',value:'Alias One'}]);
 assert.equal(revision(file,'person',PID(1)),1);
 const [receipt]=receipts(file);
 assert.deepEqual([receipt.operation,receipt.origin,receipt.target_kind,receipt.target_id,receipt.state,receipt.applied_revision],['person_mutation','epg','person',PID(1),'applied',1]);
 assert.ok(receipt.request_id.startsWith('epg:person_mutation:'),receipt.request_id);
 assert.equal(out.requestId,receipt.request_id);
 const snapshot=dump2(file),batches=env.DB.calls.batches;
 const again=await applyPersonMutation(env,{...OPEN,input:unit()});
 assert.deepEqual([again.state,again.receipt,again.requestId],['noop',false,out.requestId]);
 assert.equal(dump2(file),snapshot,'a second pass writes nothing, not even a receipt');assert.equal(env.DB.calls.batches,batches);
 const otherEvent=await applyPersonMutation(env,{...OPEN,event:'epg:run-2',input:unit({at:'2031-01-01T00:00:00.000Z'})});
 assert.equal(otherEvent.state,'noop');assert.notEqual(otherEvent.requestId,out.requestId,'the event is part of the request id');
 assert.equal(dump2(file),snapshot);
}

// 4. UPDATE of an existing Person: the stored role id and contract version are kept, a stored external id is never touched (trust, conflict, provenance), nothing is pruned, only the missing facts are added; blank never overwrites.
{
 const file=database('open'),env=envOf(file);
 seedPersons(file,[1]);
 assert.equal(sqlite(file,"INSERT INTO person_external_id (person_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('"+PID(1)+"','tmdb','11',1,0,'\"owner\"'),('"+PID(1)+"','old','x',0,1,NULL);INSERT INTO person_alias (person_id,kind,value,provenance_json) VALUES ('"+PID(1)+"','name','Alias One','\"kept\"')").status,0);
 const out=await applyPersonMutation(env,{...OPEN,input:unit({},{contractVersion:7,externalIds:[{scheme:'tmdb',value:'11',trusted:false,provenance:'weaker'},{scheme:'imdb',value:'nm1'}],aliases:[{value:'Alias One',provenance:'other'},{value:'Second'}]})});
 assert.equal(out.state,'applied');
 assert.equal(prow(file).contract_version,1,'the stored contract version is kept');assert.equal(prow(file).role_id,'director/1');
 assert.deepEqual(ext(file).map(item=>[item.scheme,item.value,item.trusted,item.conflicting,item.provenance_json]),[['imdb','nm1',0,0,null],['old','x',0,1,null],['tmdb','11',1,0,'"owner"']],'stored ids untouched, none pruned, the new one added');
 assert.deepEqual(aliasesOf(file),[{kind:'name',value:'Alias One'},{kind:'name',value:'Second'}]);
 assert.equal(one(file,"SELECT provenance_json FROM person_alias WHERE value='Alias One'"),'"kept"');
 assert.equal(revision(file,'person',PID(1)),1);
 const second=await applyPersonMutation(env,{...OPEN,event:'epg:run-2',input:unit({},{externalIds:[],aliases:[{value:'Third'}]})});
 assert.equal(second.state,'applied');assert.deepEqual([revision(file,'person',PID(1)),receipts(file).map(item=>item.state).join()],[2,'applied,applied'],'a revised Person is updated at its planned revision');
 // Nothing missing: no-op, no receipt, no revision movement, even with other facts different.
 const before=dump2(file);
 const noop=await applyPersonMutation(env,{...OPEN,input:unit({},{contractVersion:9,externalIds:[{scheme:'tmdb',value:'11',trusted:false,conflicting:true}]})});
 assert.equal(noop.state,'noop');assert.equal(dump2(file),before);
 // A row that exists without any revision (a backfilled Person) keeps its row and is revised from 0 on the first real write.
 const file2=database('open');seedPersons(file2,[1]);
 await applyPersonMutation(envOf(file2),{...OPEN,input:unit({},{externalIds:[],aliases:[{value:'N'}]})});
 assert.deepEqual([revision(file2,'person',PID(1)),receipts(file2)[0].applied_revision],[1,1]);
}

// 5. mode `existing` never creates: absent is `absent` (no receipt, no row); an existing Person is updated like any other.
{
 const file=database('open'),env=envOf(file);
 const out=await applyPersonMutation(env,{...OPEN,input:unit({mode:'existing'})});
 assert.deepEqual([out.state,out.receipt],['absent',false]);
 assert.equal(one(file,'SELECT COUNT(*) FROM person'),0);assert.equal(env.DB.calls.batches,0);assert.equal(one(file,'SELECT COUNT(*) FROM canonical_write_receipt'),0);
 assert.deepEqual(await planPersonMutation(env,unit({mode:'existing'})),{absent:true,noop:false,action:'none',revision:0,externalIds:[],aliases:[]});
 seedPersons(file,[1]);
 assert.equal((await applyPersonMutation(env,{...OPEN,input:unit({mode:'existing'})})).state,'applied');
 // vanishing between the pre-plan and the fresh read of the write: refused, never created.
 {
  const file3=database('open');seedPersons(file3,[1]);
  let first=0;
  const gone=envOf(file3,{onBatch:async()=>{first++;if(first===1)assert.equal(sqlite(file3,"DELETE FROM person WHERE id='"+PID(1)+"'").status,0);}});
  await assert.rejects(()=>applyPersonMutation(gone,{...OPEN,input:unit({mode:'existing'})}),code('film_person_reference'));
  assert.equal(one(file3,'SELECT COUNT(*) FROM person'),0);
 }
 // vanishing between the pre-plan and the batch: the Person is never recreated by a mode `existing` unit.
 const file2=database('open');seedPersons(file2,[1]);
 let seen=0;
 const racing=envOf(file2,{onBatch:async()=>{seen++;if(seen===2)assert.equal(sqlite(file2,"DELETE FROM person WHERE id='"+PID(1)+"'").status,0);}});
 await assert.rejects(()=>applyPersonMutation(racing,{...OPEN,input:unit({mode:'existing'})}),code('film_person_precondition'));
 assert.equal(one(file2,'SELECT COUNT(*) FROM person'),0,'a vanished Person is not recreated');
 assert.equal(receipts(file2)[0].state,'failed');
}

// 6. Refusals BEFORE any receipt: a role id that disagrees with the stored row or belongs to another Person (person_role_collision); a trusted id against a different stored trusted value (identity_collision).
{
 const file=database('open'),env=envOf(file);
 seedPersons(file,[1,2]);
 await assert.rejects(()=>applyPersonMutation(env,{...OPEN,input:unit({},{roleId:'director/9'})}),code('person_role_collision'));
 await assert.rejects(()=>applyPersonMutation(env,{...OPEN,input:unit({id:PID(3)},{roleId:'director/2'})}),code('person_role_collision'));
 assert.equal(sqlite(file,"INSERT INTO person_external_id (person_id,scheme,value,trusted,conflicting) VALUES ('"+PID(1)+"','tmdb','99',1,0)").status,0);
 await assert.rejects(()=>applyPersonMutation(env,{...OPEN,input:unit()}),code('identity_collision'));
 await assert.rejects(()=>applyPersonMutation(env,{...OPEN,input:unit({},{contractVersion:0})}),code('film_person_invalid'));
 assert.equal(env.DB.calls.batches,0);assert.equal(one(file,'SELECT COUNT(*) FROM canonical_write_receipt'),0);assert.equal(one(file,'SELECT COUNT(*) FROM person_alias'),0);
 {
  const input=unit(),clash={requestId:'r',operation:'person_mutation',target:{kind:'person',id:PID(1)},contentDigest:await personMutationDigest(input)};
  assert.equal(await personMutationOperation({replan:async()=>input}).revalidate(env,clash),'stale','a trusted-id clash is a content refusal');
 }
 // an untrusted second value of the same scheme is added (nothing is pruned, nothing overwritten).
 assert.equal((await applyPersonMutation(env,{...OPEN,input:unit({},{externalIds:[{scheme:'tmdb',value:'11'}],aliases:[]})})).state,'applied');
 assert.equal(one(file,"SELECT COUNT(*) FROM person_external_id WHERE person_id='"+PID(1)+"' AND scheme='tmdb'"),2);
}

// 6b. A trusted external id is owned by ONE Person (schema v1 has no unique index): another Person's trusted (scheme, value) is refused before any receipt, also for a created Person; untrusted or conflicting copies are fine;
// an owner that appears after the fresh read rolls the whole batch back (retryable), and the same request id then ends refused, never admitted.
{
 const file=database('open'),env=envOf(file);
 seedPersons(file,[1,2]);
 assert.equal(sqlite(file,"INSERT INTO person_external_id (person_id,scheme,value,trusted,conflicting) VALUES ('"+PID(2)+"','tmdb','11',1,0)").status,0);
 for(const id of [PID(1),PID(3)])await assert.rejects(()=>applyPersonMutation(env,{...OPEN,input:unit({id},{roleId:id===PID(1)?'director/1':'director/3'})}),code('identity_collision'),id);
 assert.equal(env.DB.calls.batches,0);assert.equal(one(file,'SELECT COUNT(*) FROM canonical_write_receipt'),0);assert.equal(one(file,'SELECT COUNT(*) FROM person'),2);
 const copy=await applyPersonMutation(env,{...OPEN,input:unit({},{externalIds:[{scheme:'tmdb',value:'11'},{scheme:'tmdb',value:'12',trusted:true,conflicting:true}],aliases:[]})});
 assert.equal(copy.state,'applied','an untrusted or conflicting copy is not a second owner');
 // the writer's own assertion (the race window): a call that opts in is refused in the batch, one that does not is not.
 const mine={id:PID(1),expectedRevision:revision(file,'person',PID(1)),at:T,presence:'existing',person:{roleId:'director/1',contractVersion:1,externalIds:[{scheme:'tmdb',value:'11',trusted:true}]}};
 await assert.rejects(()=>mutatePerson(env,{...mine,uniqueTrusted:true}),code('film_person_precondition'));
 await assert.rejects(()=>mutatePerson(env,{...mine,uniqueTrusted:1}),code('film_person_invalid'));
 await assert.rejects(()=>mutatePerson(env,{...mine,uniqueTrusted:true,person:{...mine.person,externalIds:Array.from({length:41},(_,i)=>({scheme:'x',value:String(i),trusted:true}))}}),code('film_person_bounded'));
 const before=revision(file,'person',PID(1));
 assert.equal((await mutatePerson(env,{...mine,uniqueTrusted:true,person:{...mine.person,externalIds:[{scheme:'tmdb',value:'77',trusted:true},{scheme:'x',value:'1'}]}})).revision,before+1,'no clash: written');
}
{
 const file=database('open');seedPersons(file,[1,2]);
 let seen=0;
 const racing=envOf(file,{onBatch:async()=>{seen++;if(seen===2)assert.equal(sqlite(file,"INSERT INTO person_external_id (person_id,scheme,value,trusted,conflicting) VALUES ('"+PID(2)+"','tmdb','11',1,0)").status,0);}});
 await assert.rejects(()=>applyPersonMutation(racing,{...OPEN,input:unit()}),code('film_person_precondition'));
 assert.equal(one(file,"SELECT COUNT(*) FROM person_external_id WHERE scheme='tmdb' AND value='11'"),1,'only the other Person owns it');
 assert.equal(one(file,'SELECT COUNT(*) FROM person_alias'),0,'the whole batch rolled back');assert.equal(revision(file,'person',PID(1)),0);
 const [receipt]=receipts(file);assert.deepEqual([receipt.state,receipt.attempts],['failed',1]);
 const plan=planEpgPersonUnits({runId:'run-1',at:T,personRows:[{id:PID(1),roleId:'director/1',contractVersion:1,externalIds:unit().person.externalIds,aliases:unit().person.aliases}]});
 await reconcileEpgRun(envOf(file),{plan,now:()=>iso(61000)});
 assert.equal(receipts(file)[0].state,'abandoned','the same request id is refused, not admitted');
 assert.equal(one(file,"SELECT COUNT(*) FROM person_external_id WHERE scheme='tmdb' AND value='11'"),1);
}

// 7. Interleavings in the SAME fenced batch: a Person that APPEARS between the fresh read and the batch is not overwritten (presence:'absent'), a revisionless raw insert included; one that VANISHES is not recreated by an update.
{
 const file=database('open');
 let seen=0;
 const racing=envOf(file,{onBatch:async()=>{seen++;if(seen===2)assert.equal(sqlite(file,"INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('"+PID(1)+"','director/1',4,'"+U+"')").status,0);}});
 await assert.rejects(()=>applyPersonMutation(racing,{...OPEN,input:unit()}),code('film_person_precondition'));
 assert.deepEqual(prow(file),{role_id:'director/1',contract_version:4,updated_at:U},'the appeared row is untouched');
 assert.equal(one(file,'SELECT COUNT(*) FROM person_alias')+one(file,'SELECT COUNT(*) FROM person_external_id'),0,'the whole batch rolled back');
 assert.equal(revision(file,'person',PID(1)),0);
 const [receipt]=receipts(file);assert.deepEqual([receipt.state,receipt.attempts],['failed',1]);
 // a later own-origin pass re-plans: the Person now exists, so the same request id adds the facts as an update.
 const plan=planEpgPersonUnits({runId:'run-1',at:T,personRows:[{id:PID(1),roleId:'director/1',contractVersion:1,externalIds:unit().person.externalIds,aliases:unit().person.aliases}]});
 const rec=await reconcileEpgRun(envOf(file),{plan,now:()=>iso(61000)});
 assert.equal(rec.considered,1);
 assert.deepEqual([receipts(file)[0].state,receipts(file)[0].attempts],['applied',2]);
 assert.equal(prow(file).contract_version,4,'the appeared row keeps its contract version');assert.equal(ext(file).length,2);assert.equal(receipts(file).length,1,'the same request id, never a second receipt');
}
{
 const file=database('open');seedPersons(file,[1]);
 let seen=0;
 const racing=envOf(file,{onBatch:async()=>{seen++;if(seen===2)assert.equal(sqlite(file,"DELETE FROM person WHERE id='"+PID(1)+"'").status,0);}});
 await assert.rejects(()=>applyPersonMutation(racing,{...OPEN,input:unit()}),code('film_person_precondition'));
 assert.equal(one(file,'SELECT COUNT(*) FROM person'),0,'an update never recreates a vanished Person');
 assert.equal(one(file,'SELECT COUNT(*) FROM person_alias'),0);
}

// 8. The atomic receipt: a receipt that no longer matches this attempt rolls the WHOLE batch back (the Person included).
{
 const file=database('open');
 let seen=0;
 const racing=envOf(file,{onBatch:async()=>{seen++;if(seen===2)assert.equal(sqlite(file,"UPDATE canonical_write_receipt SET attempts=attempts+1").status,0);}});
 await assert.rejects(()=>applyPersonMutation(racing,{...OPEN,input:unit()}),code('film_person_precondition'));
 assert.equal(one(file,'SELECT COUNT(*) FROM person'),0);assert.equal(one(file,'SELECT COUNT(*) FROM person_alias'),0);assert.equal(revision(file,'person',PID(1)),0);
 assert.notEqual(receipts(file)[0].state,'applied');
 // a stale expected revision (another writer moved the Person after the pre-plan) is a retryable conflict, rolled back whole.
 const file2=database('open');seedPersons(file2,[1]);
 let step=0;
 const moved=envOf(file2,{onBatch:async()=>{step++;if(step===1)await mutatePerson(envOf(file2),{id:PID(1),expectedRevision:0,at:T,person:{roleId:'director/1',contractVersion:1,aliases:[{value:'Other'}]}});}});
 await assert.rejects(()=>applyPersonMutation(moved,{...OPEN,input:unit({},{externalIds:[],aliases:[{value:'Mine'}]})}),code('film_person_revision_conflict'));
 assert.deepEqual(aliasesOf(file2),[{kind:'name',value:'Other'}]);assert.notEqual(receipts(file2)[0].state,'applied');
}

// 9. E5: facts that another writer stored between the pre-plan and the fenced write leave nothing to write: the receipt ends `unknown` (never a second marking batch, never applied by guess).
{
 const file=database('open');
 let seen=0;
 const racing=envOf(file,{onBatch:async()=>{seen++;if(seen===1)await mutatePerson(envOf(file),{id:PID(1),expectedRevision:0,at:T,person:{roleId:'director/1',contractVersion:1,externalIds:unit().person.externalIds.map(item=>({...item})),aliases:[{value:'Alias One'}]}});}});
 const out=await applyPersonMutation(racing,{...OPEN,input:unit()});
 assert.equal(out.state,'unknown');
 assert.equal(revision(file,'person',PID(1)),1,'only the interloper wrote');
 assert.equal(receipts(file).length,1);assert.equal(racing.DB.calls.batches,2,'the interloper and the pending mark; no second marking batch');
}

// 10. Replay bound to the event: the re-plan answers only for a receipt of THIS run; another run's receipt is never replayed.
{
 const row={id:PID(1),roleId:'director/1',contractVersion:1,aliases:[{value:'A'}]};
 const p1=planEpgPersonUnits({runId:'run-1',at:T,personRows:[row]}),p2=planEpgPersonUnits({runId:'run-2',at:T,personRows:[row]});
 const digest=await personMutationDigest(p1.units[0].input);
 const receipt={operation:'person_mutation',target:{kind:'person',id:PID(1)},contentDigest:digest,requestId:'epg:person_mutation:'+'x'};
 receipt.requestId=await (await load('canonical-producer-adapters.js')).producerRequestId({origin:'epg',operation:'person_mutation',event:'epg:run-1',target:receipt.target,digest});
 assert.deepEqual(await epgPersonReplan(p1)(receipt),p1.units[0].input);
 assert.equal(await epgPersonReplan(p2)(receipt),null,'another run');
 assert.equal(await epgPersonReplan(p1)({...receipt,operation:'person_state'}),null,'another kind');
 // end to end: a failed receipt of run-1, reconciled with run-2's plan, is not replayed.
 const file=database('open');
 let seen=0;
 const racing=envOf(file,{onBatch:async()=>{seen++;if(seen===2)assert.equal(sqlite(file,"UPDATE canonical_write_receipt SET attempts=attempts+1").status,0);}});
 await applyEpgPersonUnits(racing,{plan:p1,now:()=>T});
 assert.equal(one(file,'SELECT COUNT(*) FROM person'),0);
 await reconcileEpgRun(envOf(file),{plan:p2,now:()=>iso(3600000)});
 assert.equal(one(file,'SELECT COUNT(*) FROM person'),0,'the receipt of another run is never replayed');
 assert.notEqual(receipts(file)[0].state,'applied');
 // the spec's replay itself refuses a moved source and a missing re-plan.
 const env=envOf(file),ctx={requestId:receipt.requestId,attempt:2,target:receipt.target,currentRevision:0};
 await assert.rejects(()=>personMutationOperation({replan:async()=>({...p1.units[0].input,person:{...row,aliases:[{value:'Z'}]}})}).replay(env,receipt,ctx),code('film_person_invalid'));
 await assert.rejects(()=>personMutationOperation({replan:async()=>null}).replay(env,receipt,ctx),code('producer_replan_unavailable'));
 await assert.rejects(()=>personMutationOperation({replan:async()=>{throw new Error('x');}}).replay(env,receipt,ctx),code('producer_replan_unavailable'));
 assert.throws(()=>personMutationOperation({}),code('film_person_invalid'));
 assert.deepEqual(await personMutationOperation({replan:async()=>({...p1.units[0].input,person:{...row,aliases:[{value:'Z'}]}})}).readback(env,receipt.target,receipt),{disposition:'abandon',errorClass:'producer_source_changed'});
 assert.equal(await personMutationOperation({replan:async()=>null}).revalidate(env,receipt),'stale');
 assert.equal(await personMutationOperation({replan:async()=>({...p1.units[0].input,person:{...row,aliases:[{value:'Z'}]}})}).revalidate(env,receipt),'stale','a moved source');
 assert.equal(await personMutationOperation({replan:async()=>p1.units[0].input}).revalidate(env,receipt),'proceed');
 assert.deepEqual(await personMutationOperation({replan:async()=>p1.units[0].input}).readback(env,receipt.target,receipt),{digest:null,revision:0});
 assert.deepEqual(await personMutationOperation({replan:async()=>null}).readback(env,receipt.target,receipt),{digest:null,revision:0});
 // facts stored: superseded and read back as present; a content refusal (a role that moved) is stale.
 await mutatePerson(envOf(file),{id:PID(1),expectedRevision:0,at:T,person:{roleId:'director/1',contractVersion:1,aliases:[{value:'A'}]}});
 assert.equal(await personMutationOperation({replan:async()=>p1.units[0].input}).revalidate(env,receipt),'superseded');
 assert.deepEqual(await personMutationOperation({replan:async()=>p1.units[0].input}).readback(env,receipt.target,receipt),{digest,revision:1});
 const wrongRole={...p1.units[0].input,person:{...p1.units[0].input.person,roleId:'director/9'}};
 const wrongReceipt={...receipt,contentDigest:await personMutationDigest(wrongRole)};
 assert.equal(await personMutationOperation({replan:async()=>wrongRole}).revalidate(env,wrongReceipt),'stale','a role collision is a content refusal');
 await assert.rejects(()=>personMutationOperation({replan:async()=>p1.units[0].input}).revalidate(envOf(file,{onQuery:async()=>{throw new Error('D1_ERROR: boom');}}),receipt),/boom/);
 // an absent mode `existing` Person is superseded and never created.
 const ex={...p1.units[0].input,mode:'existing',id:PID(77)},exReceipt={...receipt,target:{kind:'person',id:PID(77)},contentDigest:await personMutationDigest(ex)};
 assert.equal(await personMutationOperation({replan:async()=>ex}).revalidate(env,exReceipt),'superseded');
}

// 11. Transient D1 read failures propagate: the receipt stays due (never abandoned), a later pass settles it.
{
 const row={id:PID(1),roleId:'director/1',contractVersion:1,aliases:[{value:'A'}]};
 const p=planEpgPersonUnits({runId:'run-1',at:T,personRows:[row]});
 for(const failOn of [1,2]){
  const file=database('open');
  let seen=0;
  const racing=envOf(file,{onBatch:async()=>{seen++;if(seen===2)assert.equal(sqlite(file,"INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('"+PID(1)+"','director/1',1,'"+U+"')").status,0);}});
  await applyEpgPersonUnits(racing,{plan:p,now:()=>T});
  assert.equal(receipts(file)[0].state,'failed');
  let reads=0;
  const flaky=envOf(file,{onQuery:async text=>{if(/FROM person|FROM canonical_revision/.test(text)&&++reads===failOn)throw new Error('D1_ERROR: network connection lost');}});
  const bad=await reconcileEpgRun(flaky,{plan:p,now:()=>iso(61000)});
  assert.equal(bad.abandoned.length,0,failOn+': '+JSON.stringify(bad));
  assert.equal(receipts(file)[0].attempts,1);assert.notEqual(receipts(file)[0].state,'abandoned');
  const good=await reconcileEpgRun(envOf(file),{plan:p,now:()=>iso(121000)});
  assert.equal(good.considered,1);assert.equal(receipts(file)[0].state,'applied');
 }
 // a transient read failure of the apply itself throws (nothing is written, nothing abandoned).
 const file=database('open');
 let n2=0;
 const flaky=envOf(file,{onQuery:async text=>{if(/FROM person /.test(text)&&++n2===1)throw new Error('D1_ERROR: boom');}});
 await assert.rejects(()=>applyPersonMutation(flaky,{...OPEN,input:unit()}),/boom/);
 assert.equal(one(file,'SELECT COUNT(*) FROM canonical_write_receipt'),0);
}

// 12. Plan order with credits: person_mutation, then person_state, then film_credits. A credit whose Person the SAME run creates is applied in the same pass; one whose Person stays missing is the recoverable refusal
// film_person_reference (unchanged), before any receipt.
{
 const rowsIn=[{id:PID(2),roleId:'director/2',contractVersion:1},{id:PID(1),roleId:'director/1',contractVersion:1,aliases:[{value:'A'}]}];
 const credits=[{filmId:FID(1),credits:[{personId:PID(1),role:'director'},{personId:PID(2),role:'actor'}]}];
 const persons=[{id:PID(1),state:{identity:dim('identity')}}];
 const p=planEpgPersonUnits({runId:'run-1',at:T,persons,credits,personRows:rowsIn});
 assert.deepEqual(p.units.map(item=>[item.kind,item.id]),[['person_mutation',PID(1)],['person_mutation',PID(2)],['person_state',PID(1)],['film_credits',FID(1)]]);
 assert.equal(JSON.stringify(p),JSON.stringify(planEpgPersonUnits({runId:'run-1',at:T,persons,credits,personRows:[...rowsIn].reverse()})));
 assert.deepEqual(planEpgPersonUnits({runId:'run-1',at:T,persons,credits}).units.map(item=>item.kind),['person_state','film_credits'],'without Person rows the plan is as before');
 for(const bad of [{personRows:'x'},{personRows:[null]},{personRows:[rowsIn[0],rowsIn[0]]},{personRows:[{id:FID(1),roleId:'a',contractVersion:1}]},{personRows:[{id:PID(1),roleId:'',contractVersion:1}]},{personRows:[{id:PID(1),roleId:'a'}]},{personRows:[{id:PID(1),roleId:'a',contractVersion:1,mode:'x'}]}])
  assert.throws(()=>planEpgPersonUnits({runId:'r',at:T,...bad}),code('film_person_invalid'),JSON.stringify(bad));
 const file=database('open');seedFilm(file,1);
 const out=await applyEpgPersonUnits(envOf(file),{plan:p,now:()=>T});
 assert.deepEqual([out.skipped,out.done,out.counts.applied,out.counts.failed,out.stoppedBy],[false,true,4,0,null],JSON.stringify(out));
 assert.deepEqual(rows(file,"SELECT person_id,role,ordinal FROM film_person_credit WHERE film_id='"+FID(1)+"' ORDER BY role").map(item=>item.person_id),[PID(2),PID(1)]);
 assert.equal(one(file,"SELECT status FROM person_dimension WHERE person_id='"+PID(1)+"' AND dimension='identity'"),'resolved');
 assert.deepEqual(receipts(file).map(item=>item.operation).sort(),['film_credits','person_mutation','person_mutation','person_state']);
 const snapshot=dump2(file);
 const again=await applyEpgPersonUnits(envOf(file),{plan:p,now:()=>iso(5000)});
 assert.deepEqual([again.counts.noop,again.counts.applied],[4,0]);assert.equal(dump2(file),snapshot,'the second pass is a no-op without receipts');
 // Person missing and not created by the run: the credit unit refuses with the same recoverable code and no receipt.
 const file2=database('open');seedFilm(file2,1);
 const p2=planEpgPersonUnits({runId:'run-1',at:T,credits});
 const out2=await applyEpgPersonUnits(envOf(file2),{plan:p2,now:()=>T});
 assert.deepEqual([out2.counts.failed,out2.failures],[1,[{id:FID(1),code:'film_person_reference'}]]);
 assert.equal(one(file2,'SELECT COUNT(*) FROM canonical_write_receipt'),0);assert.equal(one(file2,'SELECT COUNT(*) FROM person'),0);
 // the person_state of an absent Person is still `absent`, never created by that kind.
 const out3=await applyEpgPersonUnits(envOf(database('open')),{plan:planEpgPersonUnits({runId:'run-1',at:T,persons}),now:()=>T});
 assert.deepEqual([out3.counts.absent,out3.counts.applied],[1,0]);
 // a refusal of one row unit (a role collision) does not block the others; a dormant marker skips the pass.
 const file4=database('open');seedPersons(file4,[1]);
 const p4=planEpgPersonUnits({runId:'run-1',at:T,personRows:[{id:PID(1),roleId:'director/5',contractVersion:1},{id:PID(2),roleId:'director/2',contractVersion:1}]});
 const out4=await applyEpgPersonUnits(envOf(file4),{plan:p4,now:()=>T});
 assert.deepEqual([out4.counts.applied,out4.counts.failed,out4.failures],[1,1,[{id:PID(1),code:'person_role_collision'}]]);
 assert.equal((await applyEpgPersonUnits(envOf(database('prepared')),{plan:p,now:()=>T})).skipped,true);
 assert.equal((await applyEpgPersonUnits(envOf(database('prepared')),{plan:p,now:()=>T})).counts.applied,0);
}

// 13. The bounded own-origin reconcile covers person_mutation in the same pass (the adapter's shared inline limit), and only the origin's own receipts.
{
 const row=i=>({id:PID(i),roleId:'director/'+i,contractVersion:1,aliases:[{value:'A'+i}]});
 const p=planEpgPersonUnits({runId:'run-1',at:T,personRows:[1,2,3].map(row)});
 const file=database('open');
 let seen=0;
 const racing=envOf(file,{onBatch:async statements=>{seen++;if(JSON.stringify(statements).includes("SET state='applied'"))assert.equal(sqlite(file,"UPDATE canonical_write_receipt SET attempts=attempts+1 WHERE state='pending'").status,0);}});
 await applyEpgPersonUnits(racing,{plan:p,now:()=>T});
 assert.equal(one(file,'SELECT COUNT(*) FROM canonical_write_receipt'),3);assert.equal(one(file,'SELECT COUNT(*) FROM person'),0);
 const rec=await reconcileEpgRun(envOf(file),{plan:p,now:()=>iso(3600000),limit:2});
 assert.equal(rec.considered,2,'the inline limit bounds the pass: '+JSON.stringify(rec));
 assert.equal(rec.origin,'epg');
 await assert.rejects(()=>reconcileEpgRun(envOf(file),{plan:p,filmPlan:{event:'epg:other'}}),code('film_person_run_mismatch'));
}

// 13b. The producer-run module (ADR 0128, S4-1) handles the new kind: the cursor key order (person_mutation, person_state, film_credits), the per-unit refusals of the wrapper, the ordered plan entries and the fingerprint; every code the unit raises is classed.
{
 const row=(id,over={})=>({id:PID(id),roleId:'director/'+id,contractVersion:1,aliases:[{value:'A'+id}],...over});
 const st=id=>({id:PID(id),state:{identity:dim('identity')}});
 const credits=[{filmId:FID(1),credits:[{personId:PID(1),role:'director'}]}];
 const W=input=>planEpgPersonUnitsWithRefusals({runId:'run-1',at:T,...input});
 const many=count=>Array.from({length:count},(_,i)=>({value:'a'+i}));
 const plan=W({persons:[st(1),st(2)],credits,personRows:[row(2),row(1),row(3,{roleId:''}),row(4,{aliases:many(PERSON_ITEMS_PER_UNIT_MAX+1)}),row(5,{externalIds:[{scheme:'tmdb',value:''}]})]});
 assert.deepEqual(plan.units.map(item=>item.kind+':'+item.id),['person_mutation:'+PID(1),'person_mutation:'+PID(2),'person_state:'+PID(1),'person_state:'+PID(2),'film_credits:'+FID(1)]);
 assert.deepEqual(plan.refused.map(item=>item.kind+':'+item.id+':'+item.code),['person_mutation:'+PID(3)+':film_person_invalid','person_mutation:'+PID(4)+':film_person_bounded','person_mutation:'+PID(5)+':film_person_invalid'],'the 40 bound is a per-unit refusal; the rest of the plan survives');
 assert.equal(plan.refused[1].source.aliases.length,PERSON_ITEMS_PER_UNIT_MAX+1,'the incoming row is carried whole');
 assert.equal(W({persons:[],credits:[],personRows:[row(1)]}).refused.length,0);
 assert.equal(W({persons:[st(1)],credits:[],personRows:[row(1)]}).units.length,2,'the same Person in persons and personRows is two kinds, not a duplicate');
 for(const bad of [{personRows:[row(1),row(1)]},{personRows:[row(1),row(1,{roleId:''})]},{personRows:[row(1,{roleId:''}),row(1)]},{personRows:'x'},{personRows:[{roleId:'a',contractVersion:1}]}])assert.throws(()=>W(bad),code('film_person_invalid'),JSON.stringify(bad));
 assert.throws(()=>planEpgPersonUnits({runId:'r',at:T,personRows:[row(1,{aliases:many(PERSON_ITEMS_PER_UNIT_MAX+1)})]}),code('film_person_bounded'),'the default planner still refuses the whole plan');
 // cursor order: the keys sort person_mutation < person_state < film_credits, film_facts first; a cursor on a row unit resumes at the next unit
 const keys=plan.units.map(item=>({kind:item.kind,id:item.id}));
 assert.ok(R.KIND_RANK.film_facts<R.KIND_RANK.person_mutation&&R.KIND_RANK.person_mutation<R.KIND_RANK.person_state);
 assert.deepEqual(R.assertOrdered(keys).length,5);
 assert.equal(R.resumeIndex(keys,keys[0]),1);assert.equal(R.resumeIndex(keys,keys[1]),2);assert.equal(R.resumeIndex(keys,keys[4]),5);
 assert.throws(()=>R.assertOrdered([keys[2],keys[0]]),code('film_person_invalid'));
 // entries and fingerprint: units (digested by the unit's own adapter) and refused entries in one ordered plan
 const digests=async()=>Promise.all(plan.units.map(async item=>({kind:item.kind,id:item.id,unitDigest:item.kind==='person_mutation'?await personMutationDigest(item.input):await unitDigest(item.kind,item.input)})));
 const entries=await R.buildPlanEntries({units:await digests(),refused:plan.refused});
 assert.deepEqual(entries.map(item=>item.kind+':'+item.id+(item.refusal?':'+item.refusal:'')),['person_mutation:'+PID(1),'person_mutation:'+PID(2),'person_mutation:'+PID(3)+':film_person_invalid','person_mutation:'+PID(4)+':film_person_bounded','person_mutation:'+PID(5)+':film_person_invalid','person_state:'+PID(1),'person_state:'+PID(2),'film_credits:'+FID(1)]);
 const fp=await R.planFingerprint({origin:'epg',event:plan.event,units:entries});
 assert.equal(fp,await R.planFingerprint({origin:'epg',event:plan.event,units:await R.buildPlanEntries({units:(await digests()).reverse(),refused:[...plan.refused].reverse()})}),'input order does not move the fingerprint');
 const moved=W({persons:[st(1),st(2)],credits,personRows:[row(2),row(1,{aliases:[{value:'Other'}]}),row(3,{roleId:''}),row(4,{aliases:many(PERSON_ITEMS_PER_UNIT_MAX+1)}),row(5,{externalIds:[{scheme:'tmdb',value:''}]})]});
 const movedFp=await R.planFingerprint({origin:'epg',event:moved.event,units:await R.buildPlanEntries({units:await Promise.all(moved.units.map(async item=>({kind:item.kind,id:item.id,unitDigest:item.kind==='person_mutation'?await personMutationDigest(item.input):await unitDigest(item.kind,item.input)}))),refused:moved.refused})});
 assert.notEqual(movedFp,fp,'a changed Person row moves the fingerprint');
 const without=await R.planFingerprint({origin:'epg',event:plan.event,units:entries.filter(item=>item.kind!=='person_mutation'||item.refusal)});
 assert.notEqual(without,fp,'an added row unit moves it');
 await assert.rejects(()=>R.buildPlanEntries({units:[{kind:'person_mutation',id:PID(1),unitDigest:'a'.repeat(64)}],refused:[{kind:'person_mutation',id:PID(1),code:'film_person_invalid',source:null}]}),code('film_person_invalid'),'a key in both lists refuses the plan');
 // every code the unit can raise has a class (the S4-1 scan reads this module too)
 const classes=Object.fromEntries(['film_person_invalid','film_person_bounded','film_person_reference','identity_collision','person_role_collision','film_person_precondition','film_person_revision_conflict','film_person_unavailable','film_person_held','producer_replan_unavailable'].map(item=>[item,R.classOfCode(item)]));
 assert.equal(Object.values(classes).includes(R.CLASS.UNCLASSIFIED),false,JSON.stringify(classes));
 assert.deepEqual([classes.film_person_invalid,classes.film_person_bounded],[R.CLASS.PERMANENT,R.CLASS.PERMANENT]);
 assert.deepEqual([classes.identity_collision,classes.person_role_collision,classes.film_person_precondition],[R.CLASS.UNIT,R.CLASS.UNIT,R.CLASS.UNIT]);
}

// 14. Static: dormant. Only the EPG Person layer imports the module, nothing in src, build.mjs or the Worker names it, no network, timer, cron or R2 API, no write SQL of its own (the writer is mutatePerson with the receipt tail), the writer
// option is validated, and readiness stays truthful: no operation is registered by this change, so epg_commit stays unwired.
{
 const self='src/canonical-person-mutation-producer.js';
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&full!==self&&/canonical-person-mutation-producer/.test(fs.readFileSync(full,'utf8')))importers.push(full);}};
 walk('src');
 assert.deepEqual(importers,['src/canonical-epg-person-producer.js']);
 for(const file of ['build.mjs','package.json','wrangler.toml','wrangler.jsonc'])if(fs.existsSync(file))assert.ok(!/canonical-person-mutation-producer/.test(fs.readFileSync(file,'utf8')),file+' does not bundle it');
 assert.ok(!fs.readFileSync('src/worker.js','utf8').includes('canonical-person-mutation-producer'));
 const body=fs.readFileSync(path.join(SRC,'canonical-person-mutation-producer.js'),'utf8').replace(/\/\/.*$/gm,'');
 assert.ok(!/\b(fetch|setTimeout|setInterval|scheduled|R2|BUCKET|waitUntil)\b/.test(body),'no network, timer, cron or R2 reference');
 assert.ok(!/\b(INSERT|UPDATE|DELETE|REPLACE)\b\s+(INTO|FROM)?\s*\w/.test(body),'no write SQL of its own');
 assert.ok(/mutatePerson\(/.test(body)&&/receiptMark/.test(body)&&/presence/.test(body));
 assert.deepEqual([...body.matchAll(/from '(\.\/[^']+)'/g)].map(match=>match[1]).sort(),['./canonical-mutations.js','./canonical-person-adapters.js','./canonical-producer-adapters.js','./canonical-receipts.js','./canonical-writer-route.js','./film-person-authority.js']);
 await assert.rejects(()=>mutatePerson(envOf(database('open')),{id:PID(1),expectedRevision:0,at:T,presence:'maybe',person:{roleId:'director/1',contractVersion:1}}),code('film_person_invalid'));
 assert.deepEqual([...PRODUCER_OPERATIONS.keys()],['film_mutation'],'only the Discovery admission operation (AIR-374 P3c) is registered');
 const epgWiring=PRODUCER_WIRING.find(item=>item.name==='epg_commit');
 assert.ok(epgWiring.requires.includes('person_mutation')&&epgWiring.requires.some(kind=>!PRODUCER_OPERATIONS.has(kind)));
 const readiness=await handoffReadiness(envOf(database('prepared')),{now:T});
 assert.ok(readiness.blockers.includes('producer_not_wired:epg_commit')&&readiness.ready===false);
}
console.log('canonical-person-mutation-producer: ok');
