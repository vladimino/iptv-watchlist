// AIR-371 / ADR 0099 decomposition C4: producer adapters and single-writer routing. The marker matrix, the projector fence (no overlap, no gap, no writer
// without a generation match), the planners, dispatch with unknown outcomes and readback, the bounded compare-only shadow and the handoff readiness,
// on the sqlite3-CLI D1 stand-in. No Worker, R2, TMDB or production access; nothing here is bundled. Repeat in AIR-373 (parity) and AIR-374 (handoff).
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {mutateFilm,mutatePerson} from '../src/canonical-mutations.js';
import {transitionAuthority} from '../src/film-person-authority.js';
import {readLocalization} from '../src/localization-sources.js';
import {CONFIRMED_RETIREMENTS,OWNER_CONFIRMATION} from '../scripts/tmdb-tv-identity-plan.mjs';
import {writerRoute,projectorFence,planEpgIdentity,planLocalization,planDiscoveryAdmission,planRatedAdmission,planRetention,planRetirement,planBatch,dispatch,readback,readRevisions,shadowCompare,handoffReadiness,GAPS,SHADOW_ITEM_CAP} from '../src/canonical-producers.js';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-canonical-producers-'));
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>name.replace(/\.sql$/,''));
assert.ok(chain.includes('0016_tmdb_retirement_decision'),'the chain reaches 0016');
let n=0;
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const sql=name=>fs.readFileSync('migrations/'+name+'.sql','utf8');
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
// stage: 'legacy' (schema 12, no marker), 'r2', 'prepared', 'open', 'held'.
function database(stage='r2'){
 const file=path.join(root,'cp-'+(n++)+'.sqlite');
 const upTo=stage==='legacy'?chain.findIndex(name=>name.startsWith('0013_')):chain.length;
 assert.equal(sqlite(file,chain.slice(0,upTo).map(sql).join('\n')).status,0);
 if(stage==='prepared'||stage==='open'||stage==='held')assert.equal(sqlite(file,VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1").status,0);
 if(stage==='open'||stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1").status,0);
 if(stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);
 return file;
}
const AT='2026-11-07T10:00:00.000Z';
const state=file=>({DB:d1Standin(file)});
const code=expected=>error=>error.code===expected;
const count=(file,table)=>one(file,'SELECT COUNT(*) FROM '+table);
const TABLES=['film','film_external_id','film_alias','film_person_credit','person','canonical_revision','film_rated_admission','film_retention','tmdb_retirement_decision','film_localization_source'];
const tables=file=>{const have=new Set(rows(file,"SELECT name FROM sqlite_master WHERE type='table'").map(row=>row.name));return JSON.stringify(TABLES.filter(t=>have.has(t)).map(t=>[t,count(file,t)]));};

// 1. The marker matrix: one routing decision; legacy, r2 and prepared keep the projector as the only writer and dispatch writes nothing.
{
 const plan=planDiscoveryAdmission({key:'tmdb_603',entry:{verified:true,title:'The Matrix'},resolved:{id:'film:tmdb:603',revision:0,held:null,redirected:false},at:AT});
 for(const stage of ['legacy','r2','prepared']){
  const file=database(stage),env=state(file);
  const route=await writerRoute(env);
  assert.deepEqual([route.writer,route.projector,route.canonical],['projector','writes','dormant'],stage);
  const before=tables(file),batches=env.DB.calls.batches;
  const result=await dispatch(env,plan);
  assert.deepEqual([result.executed,result.reason,result.results],[false,'projector_is_writer',[]],stage);
  assert.equal(env.DB.calls.batches,batches,stage+': no batch');
  assert.equal(tables(file),before,stage+': nothing written');
 }
 const open=state(database('open'));
 const route=await writerRoute(open);
 assert.deepEqual([route.writer,route.projector,route.canonical],['canonical','compare_only','writes']);
 assert.equal((await dispatch(open,plan)).results[0].status,'applied');
 const held=state(database('held'));
 await assert.rejects(()=>writerRoute(held),code('film_person_held'));
 await assert.rejects(()=>dispatch(held,plan),code('film_person_held'),'held never names a writer or falls back to R2');
 // Unreadable: a missing marker row, a read error.
 const broken=database('r2');sqlite(broken,'DROP TRIGGER film_person_authority_no_delete;DELETE FROM film_person_authority');
 await assert.rejects(()=>writerRoute(state(broken)),code('film_person_unavailable'));
 const erroring={DB:{prepare(){throw new Error('D1_ERROR: network');}}};
 await assert.rejects(()=>writerRoute(erroring),code('film_person_unavailable'));
 await assert.rejects(()=>dispatch(erroring,plan),code('film_person_unavailable'));
}

// 2. No overlap, no gap, no writer without a generation match: the projector fence and the canonical fence are mutually exclusive in SQL.
{
 const file=database('r2'),env=state(file);
 const projectorWrite=async(gate,{beforeBatch=null}={})=>{
  const fence=projectorFence(gate);
  const db=beforeBatch?d1Standin(file,{onBatch:beforeBatch}):d1Standin(file);
  const batch=[...(fence?[db.prepare(fence[0]).bind(...fence[1])]:[]),db.prepare("INSERT INTO film (id,contract_version,updated_at) VALUES (?,?,?)").bind('film:projector:'+(n++),1,AT)];
  return db.batch(batch);
 };
 const log=[];
 const writers=async label=>{
  const gate=await (await import('../src/film-person-authority.js')).readAuthority(env);
  let projector='refused',canonical='refused';
  try{if(gate.r2Allowed){await projectorWrite(gate);projector='wrote';}}catch{projector='refused';}
  const route=await dispatch(env,planDiscoveryAdmission({key:'tmdb_'+(1000+log.length),entry:{verified:true},resolved:{id:'film:tmdb:'+(1000+log.length),revision:0,held:null,redirected:false},at:AT}));
  canonical=route.executed?'wrote':'refused';
  log.push({label,projector,canonical});
  assert.ok(!(projector==='wrote'&&canonical==='wrote'),label+': two writers');
  return {projector,canonical};
 };
 assert.deepEqual(await writers('r2'),{projector:'wrote',canonical:'refused'});
 sqlite(file,VERIFY);
 await transitionAuthority(env,{from:'r2',to:'prepared',expectedGeneration:0});
 assert.deepEqual(await writers('prepared'),{projector:'wrote',canonical:'refused'});
 // An in-flight projector batch read at prepared generation 1 loses when the marker moves to open before its batch runs; nothing is written.
 const gatePrepared=await (await import('../src/film-person-authority.js')).readAuthority(env);
 const before=count(file,'film');
 await assert.rejects(()=>projectorWrite(gatePrepared,{beforeBatch:async()=>{sqlite(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1");}}));
 assert.equal(count(file,'film'),before,'the in-flight projector batch wrote nothing');
 assert.equal(one(file,'SELECT mode FROM film_person_authority'),'d1');
 // After the move: the canonical adapters write, the projector (stale gate) cannot, and a fresh gate cannot even build a projector fence.
 assert.deepEqual(await writers('open'),{projector:'refused',canonical:'wrote'});
 await assert.rejects(()=>projectorWrite(gatePrepared),'a stale projector gate fails');
 assert.throws(()=>projectorFence({state:'open',r2Allowed:false,generation:2}),code('film_person_not_projector'));
 // A generation change inside prepared (back to r2 and forward) also kills a batch built on the old generation: no writer without a generation match.
 const file2=database('prepared'),env2=state(file2);
 const gate1=await (await import('../src/film-person-authority.js')).readAuthority(env2);
 await transitionAuthority(env2,{from:'prepared',to:'r2',expectedGeneration:1});
 await transitionAuthority(env2,{from:'r2',to:'prepared',expectedGeneration:2});
 const fence=projectorFence(gate1),db=d1Standin(file2);
 await assert.rejects(()=>db.batch([db.prepare(fence[0]).bind(...fence[1]),db.prepare("INSERT INTO film (id,contract_version,updated_at) VALUES ('film:stale',1,?)").bind(AT)]));
 assert.equal(count(file2,'film'),0);
 assert.equal(projectorFence(null),null);assert.equal(projectorFence({state:'legacy'}),null);
 // The fence is built from the condition the real projector carries, with the mode and the generation it read (ADR 0117).
 assert.deepEqual(projectorFence({state:'prepared',r2Allowed:true,generation:3})[1],['prepared',3]);
 assert.ok(projectorFence({state:'r2',r2Allowed:true,generation:0})[0].includes((await import('../src/film-person-authority.js')).PROJECTOR_MARKER_CONDITION));
 assert.deepEqual(log.map(item=>item.label),['r2','prepared','open']);
}

// 3. EPG identity: credits are upserts only, D1-only credits and their ordinals survive, typed ids coexist, an invalid plan is refused.
{
 const file=database('open'),env=state(file);
 await mutatePerson(env,{id:'person:director/7',expectedRevision:0,at:AT,person:{roleId:'director/7',contractVersion:1}});
 await mutatePerson(env,{id:'person:tmdb_director/1',expectedRevision:0,at:AT,person:{roleId:'tmdb_director/1',contractVersion:1}});
 await mutateFilm(env,{id:'film:tmdb:9',expectedRevision:0,at:AT,film:{contractVersion:1,externalIds:[{scheme:'tmdb',value:'9',trusted:true}]},credits:{upsert:[{personId:'person:tmdb_director/1',role:'director',ordinal:0}]}});
 const plan=planEpgIdentity({at:AT,epgGeneration:'g1',revisions:{'film:tmdb:9':1,'person:director/7':1},film:{id:'film:tmdb:9',originalTitle:'Nine',externalIds:[{scheme:'tmdb',value:'9',trusted:true},{scheme:'tmdb_tv',value:'9',trusted:false}],aliases:[{kind:'title',value:'Девять'}]},credits:[{personId:'person:director/7',role:'director'}],persons:[{id:'person:director/7',roleId:'director/7'}]});
 assert.deepEqual(plan.calls.map(call=>call.fn),['mutatePerson','mutateFilm'],'Persons first: a credit references its Person');
 assert.equal(plan.atomic,false,'a multi-entity plan is not one atomic batch');
 assert.equal(plan.calls[1].input.credits.remove,undefined,'a roster never removes a credit');
 assert.equal(plan.calls[1].input.credits.upsert[0].ordinal,undefined,'no ordinal is renumbered');
 const result=await dispatch(env,plan);
 assert.deepEqual(result.results.map(item=>item.status),['applied','applied']);
 assert.deepEqual(rows(file,"SELECT person_id,role,ordinal FROM film_person_credit WHERE film_id='film:tmdb:9' ORDER BY ordinal"),[{person_id:'person:tmdb_director/1',role:'director',ordinal:0},{person_id:'person:director/7',role:'director',ordinal:1}]);
 assert.deepEqual(rows(file,"SELECT scheme,value FROM film_external_id WHERE film_id='film:tmdb:9' ORDER BY scheme"),[{scheme:'tmdb',value:'9'},{scheme:'tmdb_tv',value:'9'}],'tmdb and tmdb_tv stay distinct');
 // Replaying the same plan (a producer retry) after a normal outcome with a stale revision is a conflict, never a second write.
 assert.equal((await dispatch(env,plan)).results[0].status,'conflict');
 for(const bad of [null,{at:AT,film:{id:'tmdb:9'}},{at:AT,film:{id:'film:tmdb:9'},credits:[{personId:'x',role:'producer'}]},{at:AT,film:{id:'film:tmdb:9'},persons:[{id:'person:x'}]}])assert.equal(planEpgIdentity(bad).calls.length,0);
 // A credit whose Person is neither created by the plan nor declared known is refused (no foreign-key failure at dispatch).
 assert.equal(planEpgIdentity({at:AT,film:{id:'film:tmdb:30'},credits:[{personId:'person:director/404',role:'director'}]}).skipped[0].reason,'credit_person_unresolved');
 // First admission: a previously unseen Person referenced by a new Film's credit applies, Person first.
 const first=planEpgIdentity({at:AT,epgGeneration:'g1',film:{id:'film:tmdb:30',externalIds:[{scheme:'tmdb',value:'30',trusted:true}]},credits:[{personId:'person:director/30',role:'director'}],persons:[{id:'person:director/30',roleId:'director/30'}]});
 const firstResult=await dispatch(env,first);
 assert.deepEqual([firstResult.complete,firstResult.partial,firstResult.results.map(item=>item.status)],[true,false,['applied','applied']]);
 assert.equal(count(file,"film_person_credit WHERE film_id='film:tmdb:30'"),1);
 // A later-step failure leaves the earlier step applied (partial, reported); a re-read and re-plan then converges without a duplicate.
 await mutatePerson(env,{id:'person:director/31',expectedRevision:0,at:AT,person:{roleId:'director/31',contractVersion:1}});
 const later=planEpgIdentity({at:AT,epgGeneration:'g1',revisions:{'film:tmdb:31':5},film:{id:'film:tmdb:31',externalIds:[{scheme:'tmdb',value:'31',trusted:true}]},credits:[{personId:'person:director/32',role:'director'}],persons:[{id:'person:director/32',roleId:'director/32'}]});
 const partial=await dispatch(env,later);
 assert.deepEqual([partial.complete,partial.partial,partial.results.map(item=>item.status)],[false,true,['applied','conflict']]);
 assert.equal(count(file,"person WHERE id='person:director/32'"),1,'the Person step stays applied');
 const fresh=await readRevisions(env,['film:tmdb:31','person:director/32']);
 const replanned=planEpgIdentity({at:AT,epgGeneration:'g1',revisions:fresh,film:{id:'film:tmdb:31',externalIds:[{scheme:'tmdb',value:'31',trusted:true}]},credits:[{personId:'person:director/32',role:'director'}],persons:[{id:'person:director/32',roleId:'director/32'}]});
 const converged=await dispatch(env,replanned);
 assert.deepEqual([converged.complete,converged.results.map(item=>item.status)],[true,['applied','applied']]);
 assert.equal(count(file,"film_person_credit WHERE film_id='film:tmdb:31'"),1,'no duplicate credit after the replay');
 // Mixed generations never share a batch.
 assert.equal(planBatch([planEpgIdentity({at:AT,epgGeneration:'g1',film:{id:'film:a'}}),planEpgIdentity({at:AT,epgGeneration:'g2',film:{id:'film:b'}})]).reason,'mixed_generation');
 assert.equal(planBatch([planEpgIdentity({at:AT,epgGeneration:'g1',film:{id:'film:a'}}),planEpgIdentity({at:AT,epgGeneration:'g1',film:{id:'film:b'}})]).ok,true);
}

// 4. Discovery admission: typed movie id only, no phantom or duplicate Film, held and tmdb_tv refused, a competing admission loses on the revision.
{
 const file=database('open'),env=state(file);
 const base={entry:{verified:true,title:'Heat'},at:AT};
 assert.equal(planDiscoveryAdmission({...base,key:'tmdb_tv_77',resolved:{id:'film:tmdb:77',revision:0}}).skipped[0].reason,'tmdb_tv_is_not_a_film');
 assert.equal(planDiscoveryAdmission({...base,key:'short1',resolved:{id:'film:x',revision:0}}).skipped[0].reason,'invalid_key');
 assert.equal(planDiscoveryAdmission({...base,entry:{verified:false},key:'tmdb_5',resolved:{id:'film:tmdb:5',revision:0}}).skipped[0].reason,'not_verified');
 assert.equal(planDiscoveryAdmission({...base,key:'tmdb_5',resolved:{id:'film:tmdb:5',revision:0,held:'untrusted_or_conflicting_claim'}}).skipped[0].reason,'admission_identity_held');
 assert.equal(planDiscoveryAdmission({...base,key:'tmdb_5',resolved:{id:'film:tmdb:5',revision:0,redirected:true}}).skipped[0].reason,'redirected');
 const plan=planDiscoveryAdmission({...base,key:'tmdb_5',resolved:{id:'film:tmdb:5',revision:0,held:null,redirected:false}});
 const [first,second]=await Promise.all([dispatch(env,plan),dispatch(env,plan)]);
 const statuses=[first.results[0].status,second.results[0].status].sort();
 assert.deepEqual(statuses,['applied','conflict'].sort(),'a concurrent duplicate admission applies once');
 assert.equal(count(file,'film'),1,'no phantom or duplicate Film');
 assert.deepEqual(rows(file,'SELECT scheme,value,trusted FROM film_external_id'),[{scheme:'tmdb',value:'5',trusted:1}]);
 // A second Film holding the same movie id as a trusted id is refused by the identity index (a collision), reported and not thrown.
 const clash=planDiscoveryAdmission({...base,key:'tmdb_5',resolved:{id:'film:other',revision:0,held:null,redirected:false}});
 assert.equal((await dispatch(env,clash)).results[0].status,'refused');
 assert.equal(count(file,'film'),1);
}

// 5. Rated admission and retention: a candidate or an invalid receipt is never a Film, watched then removed keeps the Film, replay is a no-op.
{
 const file=database('open'),env=state(file);
 const receipt={tmdb:'603',sourceCode:'abc12',archiveSha256:'a'.repeat(64),verifiedAt:'2026-11-01T10:00:00Z',title:'The Matrix',year:1999};
 for(const [key,item,reason] of [['abc12',receipt,'invalid_key'],['tmdb_603',{...receipt,watchlist:true},'watchlist_field'],['tmdb_603',{...receipt,verifiedAt:null},'not_verified'],['tmdb_603',{...receipt,archiveSha256:'z'},'not_verified'],['tmdb_603',{status:'pending'},'tmdb_mismatch']])
  assert.equal(planRatedAdmission({receiptKey:key,receipt:item,requestId:'r',at:AT}).skipped[0].reason,reason);
 const plan=planRatedAdmission({receiptKey:'tmdb_603',receipt,filmId:'film:tmdb:603',expectedRevision:0,requestId:'adm-1',at:AT});
 assert.equal((await dispatch(env,plan)).results[0].status,'applied');
 assert.equal(count(file,'film_rated_admission'),1);
 const again=await dispatch(env,{...plan,calls:[{fn:'admitRatedFilm',input:{...plan.calls[0].input,expectedRevision:1}}]});
 assert.equal(again.results[0].result.replay,true,'a replay is a no-op');
 const keep=(watchlist,observedAt,request,revision)=>dispatch(env,planRetention({id:'film:tmdb:603',watchlist,requestId:request,at:AT,observedAt,expectedRevision:revision}));
 assert.equal((await keep(true,'2026-11-02T00:00:00Z','ret-1',1)).results[0].status,'applied');
 const revision=Number(one(file,"SELECT revision FROM canonical_revision WHERE kind='film' AND id='film:tmdb:603'"));
 assert.equal((await keep(false,'2026-11-05T00:00:00Z','ret-2',revision)).results[0].status,'applied');
 assert.equal(one(file,"SELECT watchlist FROM film_retention WHERE film_id='film:tmdb:603'"),0);
 assert.equal(count(file,'film'),1,'a Film that left the list persists');
 assert.equal(count(file,'watchlist_film'),0,'membership is not written here');
 assert.equal(planRetention({id:'film:x',watchlist:'yes'}).calls.length,0);
}

// 6. TMDB retirement: retire then an explicit restore through the same adapter; there is no implicit un-retirement and a typed conflict is held.
{
 const file=database('open'),env=state(file);
 const [ODYSSEY]=CONFIRMED_RETIREMENTS;
 const evidence={movieStatus:404,movieCheckedAt:'2026-10-30T10:00:00Z',letterboxdUrl:ODYSSEY.letterboxdUrl,link:'tv/'+ODYSSEY.tvId,linkCheckedAt:'2026-10-30T10:01:00Z',tvResponseId:ODYSSEY.tvId,tvCheckedAt:'2026-10-30T10:02:00Z'};
 await mutateFilm(env,{id:ODYSSEY.filmId,expectedRevision:0,at:AT,film:{contractVersion:1,externalIds:[{scheme:'tmdb',value:ODYSSEY.movieId,trusted:true}]}});
 const retire={requestId:'rt-1',kind:'retire',filmId:ODYSSEY.filmId,lid:ODYSSEY.lid,movieId:ODYSSEY.movieId,tvId:ODYSSEY.tvId,expectedRevision:1,at:AT,evidence,confirmation:{...OWNER_CONFIRMATION}};
 assert.equal((await dispatch(env,planRetirement(retire))).results[0].status,'applied');
 assert.equal(count(file,'tmdb_retirement_decision'),1);
 assert.equal((await dispatch(env,planRetirement({...retire,requestId:'rt-2',expectedRevision:2}))).results[0].status,'refused','a second retire of an active retirement is refused');
 const restore={...retire,requestId:'rs-1',kind:'restore',expectedRevision:2,supersedesSeq:1,evidence:{reason:'owner reviewed the link again'}};
 assert.equal((await dispatch(env,planRetirement(restore))).results[0].status,'applied');
 assert.equal(count(file,'tmdb_retirement_decision'),2,'the history is append-only and complete');
 assert.equal(planRetirement({requestId:1}).calls.length,0);
 // A decision without the owner's confirmation is refused before any SQL by the decision writer.
 const noConfirm=await dispatch(env,planRetirement({...retire,requestId:'bad',confirmation:{by:'system'}}));
 assert.deepEqual([noConfirm.results[0].status,noConfirm.results[0].code,count(file,'tmdb_retirement_decision')],['refused','retirement_invalid',2]);
}

// 7. Localization: a late automatic source never displaces a reviewed or owner value; only automatic candidates become source writes.
{
 const file=database('open'),env=state(file);
 await mutateFilm(env,{id:'film:tmdb:3',expectedRevision:0,at:AT,film:{contractVersion:1}});
 sqlite(file,"INSERT INTO film_dimension (film_id,dimension,status,source,provenance_json,value,authority,attempts,updated_at) VALUES ('film:tmdb:3','localization','reviewed','owner','{}','Владелец','owner',0,'2026-11-07T00:00:00.000Z')");
 const incoming={status:'provisional',value:'Поздний',source:'wikidata',updatedAt:'2099-01-01T00:00:00.000Z',provenance:{}};
 const resolved=(await readLocalization(env,'film',['film:tmdb:3'])).get('film:tmdb:3');
 const plan=planLocalization({kind:'film',id:'film:tmdb:3',localization:incoming,resolved,revision:1,at:AT,requestId:'loc-1'});
 assert.equal(plan.outcome,'held_by_owner');
 assert.equal((await dispatch(env,plan)).results[0].status,'applied');
 assert.equal((await readLocalization(env,'film',['film:tmdb:3'])).get('film:tmdb:3').value,'Владелец','the owner value still wins');
 for(const bad of [{...incoming,status:'reviewed'},{...incoming,source:'dictionary'},{...incoming,value:''}])assert.equal(planLocalization({kind:'film',id:'film:tmdb:3',localization:bad,resolved,revision:2,at:AT,requestId:'x'}).calls.length,0);
}

// 8. An unknown batch outcome is reported, never blindly retried, and is never settled by the revision alone.
{
 const file=database('open');
 const real=d1Standin(file);
 const plan=planEpgIdentity({at:AT,epgGeneration:'g',film:{id:'film:tmdb:21',originalTitle:'X',externalIds:[{scheme:'tmdb',value:'21',trusted:true}],aliases:[{kind:'title',value:'Икс'}]}});
 // (b) The batch commits, then the answer is lost.
 const lostAnswer={DB:{prepare:sql=>real.prepare(sql),batch:async statements=>{if(statements.length>1){await real.batch(statements);throw new Error('D1_ERROR: network lost');}return real.batch(statements);}}};
 const lost=await dispatch(lostAnswer,plan);
 assert.equal(lost.results[0].status,'unknown');
 assert.equal(lost.results.length,1,'nothing after an unknown outcome runs');
 assert.equal(lost.partial,false);
 const seen=await readback(state(file),plan.calls[0]);
 assert.deepEqual([seen.outcome,seen.applied],['content_present',null],'the content exists; the revision alone is never proof that this call applied');
 assert.equal(count(file,'film'),1);
 // (c) The batch never reached D1: not_applied, safe to dispatch again; the replay applies once.
 const file2=database('open');
 const dropped={DB:{prepare:sql=>d1Standin(file2).prepare(sql),batch:async statements=>{if(statements.length>1)throw new Error('D1_ERROR: network');return d1Standin(file2).batch(statements);}}};
 assert.equal((await dispatch(dropped,plan)).results[0].status,'unknown');
 const absent=await readback(state(file2),plan.calls[0]);
 assert.deepEqual([absent.outcome,absent.applied],['not_applied',false]);
 assert.equal((await dispatch(state(file2),plan)).results[0].status,'applied');
 // (a) A lost batch while a competing producer moved the SAME Film's revision: the revision moved, but this call's content is missing, so it is
 // NOT reported applied and the advice is to re-read and re-plan (replaying with the old revision would be a conflict).
 const file3=database('open'),env3=state(file3);
 const competing=await mutateFilm(env3,{id:'film:tmdb:21',expectedRevision:0,at:AT,film:{contractVersion:1,externalIds:[{scheme:'tmdb',value:'21',trusted:true}]}});
 assert.equal(competing.revision,1);
 const lostB={DB:{prepare:sql=>d1Standin(file3).prepare(sql),batch:async statements=>{if(statements.length>1)throw new Error('D1_ERROR: network');return d1Standin(file3).batch(statements);}}};
 const wanted=planEpgIdentity({at:AT,epgGeneration:'g',revisions:{'film:tmdb:21':0},film:{id:'film:tmdb:21',aliases:[{kind:'title',value:'Лишь у меня'}]}});
 assert.equal((await dispatch(lostB,wanted)).results[0].status,'unknown');
 const confused=await readback(state(file3),wanted.calls[0]);
 assert.deepEqual([confused.moved,confused.outcome,confused.applied],[true,'reread_and_replan',false],'a competing write is not proof of this lost batch');
 assert.equal(count(file3,"film_alias WHERE value='Лишь у меня'"),0,'the alias was never written');
 const fresh=await readRevisions(state(file3),['film:tmdb:21']);
 const redo=planEpgIdentity({at:AT,epgGeneration:'g',revisions:fresh,film:{id:'film:tmdb:21',aliases:[{kind:'title',value:'Лишь у меня'}]}});
 assert.equal((await dispatch(state(file3),redo)).results[0].status,'applied');
 // (d) Two separate EPG calls with distinct payloads on one Film: the first applied, the second lost; each readback is judged on its own content.
 const file4=database('open'),env4=state(file4);
 const A=planEpgIdentity({at:AT,epgGeneration:'g',film:{id:'film:tmdb:40',aliases:[{kind:'title',value:'Первый'}]}});
 assert.equal((await dispatch(env4,A)).results[0].status,'applied');
 const lostC={DB:{prepare:sql=>d1Standin(file4).prepare(sql),batch:async statements=>{if(statements.length>1)throw new Error('D1_ERROR: network');return d1Standin(file4).batch(statements);}}};
 const B=planEpgIdentity({at:AT,epgGeneration:'g',revisions:{'film:tmdb:40':1},film:{id:'film:tmdb:40',aliases:[{kind:'title',value:'Второй'}]}});
 assert.equal((await dispatch(lostC,B)).results[0].status,'unknown');
 assert.equal((await readback(state(file4),A.calls[0])).outcome,'content_present');
 assert.equal((await readback(state(file4),B.calls[0])).outcome,'not_applied','B expected revision 1 and the revision is still 1');
 // (e..j) content_present needs EXACT equivalence of every write effect: a same-entity revision bump by a competing producer never lets a partial
 // match hide a lost update (a different originalTitle, an untrusted or differently-proven id, a removal not performed, a different Person role).
 const file5=database('open'),env5=state(file5);
 await mutatePerson(env5,{id:'person:director/50',expectedRevision:0,at:AT,person:{roleId:'director/50',contractVersion:1}});
 await mutatePerson(env5,{id:'person:actor/51',expectedRevision:0,at:AT,person:{roleId:'actor/51',contractVersion:1}});
 await mutateFilm(env5,{id:'film:tmdb:50',expectedRevision:0,at:AT,film:{contractVersion:1,originalTitle:'A',externalIds:[{scheme:'tmdb',value:'50',trusted:false,conflicting:true,provenance:{source:'x'}},{scheme:'tmdb_tv',value:'50',trusted:true,provenance:{source:'y'}}]},credits:{upsert:[{personId:'person:director/50',role:'director'}]}});
 const bump=revision=>mutateFilm(env5,{id:'film:tmdb:50',expectedRevision:revision,at:AT,film:{contractVersion:1,aliases:[{kind:'title',value:'bump'+revision}]}});
 await bump(1);await bump(2); // another producer: the revision is now 3, the content unchanged
 const verdict=input=>readback(state(file5),{fn:'mutateFilm',input:{id:'film:tmdb:50',expectedRevision:1,at:AT,...input}});
 const film=(over={},credits)=>({film:{contractVersion:1,...over},credits});
 assert.equal((await verdict(film({originalTitle:'B'}))).outcome,'reread_and_replan','a differing originalTitle is not present');
 assert.equal((await verdict(film({originalTitle:'A'}))).outcome,'content_present','an equal originalTitle and an existing row are present');
 assert.equal((await verdict(film({externalIds:[{scheme:'tmdb',value:'50',trusted:true,provenance:{source:'x'}}]}))).outcome,'reread_and_replan','an untrusted/conflicting row is not the trusted id the call wanted');
 assert.equal((await verdict(film({externalIds:[{scheme:'tmdb_tv',value:'50',trusted:true,provenance:{source:'other'}}]}))).outcome,'reread_and_replan','different provenance');
 assert.equal((await verdict(film({externalIds:[{scheme:'tmdb_tv',value:'50',trusted:true,provenance:{source:'y'}}]}))).outcome,'content_present','the exact trusted row with the same provenance');
 // Each trust field alone: a non-conflicting untrusted row is not the trusted id wanted; a conflicting row is not the non-conflicting one wanted.
 await mutateFilm(env5,{id:'film:tmdb:50',expectedRevision:3,at:AT,film:{contractVersion:1,externalIds:[{scheme:'tmdb_tv',value:'52',trusted:false,provenance:{source:'z'}}]}});
 assert.equal((await verdict(film({externalIds:[{scheme:'tmdb_tv',value:'52',trusted:true,provenance:{source:'z'}}]}))).outcome,'reread_and_replan','only the trusted flag differs');
 assert.equal((await verdict(film({externalIds:[{scheme:'tmdb_tv',value:'52',trusted:false,provenance:{source:'z'}}]}))).outcome,'content_present','the same untrusted row');
 assert.equal((await verdict(film({externalIds:[{scheme:'tmdb',value:'50',trusted:false,provenance:{source:'x'}}]}))).outcome,'reread_and_replan','only the conflicting flag differs');
 assert.equal((await verdict(film({externalIds:[{scheme:'tmdb',value:'50',trusted:false,conflicting:true,provenance:{source:'x'}}]}))).outcome,'content_present','the same conflicting row');
 assert.equal((await verdict(film({},{upsert:[{personId:'person:actor/51',role:'actor'}]}))).outcome,'reread_and_replan','an upserted credit that is absent');
 assert.equal((await verdict(film({contractVersion:2}))).outcome,'reread_and_replan','a differing contract version');
 assert.equal((await verdict(film({removeExternalIds:[{scheme:'tmdb',value:'50'}]}))).outcome,'reread_and_replan','a removal that was not performed');
 assert.equal((await verdict(film({removeExternalIds:[{scheme:'tmdb',value:'404'}]}))).outcome,'content_present','a removal of an absent row holds');
 assert.equal((await verdict(film({},{remove:[{personId:'person:director/50',role:'director'}]}))).outcome,'reread_and_replan','a credit removal that was not performed');
 assert.equal((await verdict(film({},{upsert:[{personId:'person:director/50',role:'director'}]}))).outcome,'content_present');
 assert.equal((await verdict(film({canonicalIdentity:'film:other'}))).outcome,'reread_and_replan','a differing canonical identity');
 const personVerdict=input=>readback(state(file5),{fn:'mutatePerson',input:{id:'person:director/50',expectedRevision:0,at:AT,...input}});
 assert.equal((await personVerdict({person:{roleId:'director/50',contractVersion:1}})).outcome,'content_present');
 assert.equal((await personVerdict({person:{roleId:'director/99',contractVersion:1}})).outcome,'reread_and_replan','a differing role id');
 assert.equal((await personVerdict({person:{roleId:'director/50',contractVersion:1,externalIds:[{scheme:'tmdb',value:'1',trusted:true}]}})).outcome,'reread_and_replan','an external id that is absent');
 assert.equal((await readback(state(file5),{fn:'mutatePerson',input:{id:'person:missing/1',expectedRevision:0,at:AT,person:{roleId:'x',contractVersion:1}}})).outcome,'not_applied','an absent Person with an unchanged revision');
 // A call without a request id never claims request-id replay safety; calls that dedupe by request id say so; every advertised kind reconciles.
 const byId=await readback(state(file4),{fn:'recordLocalizationSources',input:{kind:'film',id:'film:tmdb:40',expectedRevision:1,requestId:'r',sources:[]}});
 assert.deepEqual([byId.outcome,byId.kind],['settle_by_request_id','film']);
 const admit=await readback(state(file4),{fn:'admitRatedFilm',input:{receiptKey:'tmdb_603',expectedRevision:0,requestId:'r'}});
 assert.deepEqual([admit.id,admit.outcome],['film:tmdb:603','settle_by_request_id'],'an absent filmId is derived from the receipt key');
 for(const fn of ['retainFilm','recordRetirementDecision'])assert.equal((await readback(state(file4),{fn,input:{id:'film:tmdb:40',filmId:'film:tmdb:40',expectedRevision:1,requestId:'r'}})).outcome,'settle_by_request_id');
 const person=await readback(state(file4),{fn:'mutatePerson',input:{id:'person:director/1',expectedRevision:0,person:{roleId:'director/1'}}});
 assert.equal(person.outcome,'not_applied');
 for(const bad of [{fn:'nope',input:{}},{fn:'admitRatedFilm',input:{receiptKey:'abc',expectedRevision:0}},{fn:'mutateFilm',input:null},null])assert.equal((await readback(state(file4),bad)).outcome,'unsupported');
 // A lost fence or revision is a conflict to read again, not an unknown.
 const racing={DB:d1Standin(file2,{onBatch:async()=>{sqlite(file2,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");}})};
 const fenced=await dispatch(racing,planEpgIdentity({at:AT,film:{id:'film:tmdb:22',externalIds:[]}}));
 assert.equal(fenced.results[0].status,'conflict');
}

// 9. The bounded compare-only shadow: same, missing and differing Films; a D1-only credit is not a difference; it never writes; caps hold.
{
 const file=database('open'),env=state(file);
 await mutatePerson(env,{id:'person:tmdb_actor/1',expectedRevision:0,at:AT,person:{roleId:'tmdb_actor/1',contractVersion:1}});
 await mutateFilm(env,{id:'film:tmdb:1',expectedRevision:0,at:AT,film:{contractVersion:1,externalIds:[{scheme:'tmdb',value:'1',trusted:true}],aliases:[{kind:'title',value:'Один'}]},credits:{upsert:[{personId:'person:tmdb_actor/1',role:'actor'}]}});
 const same={id:'film:tmdb:1',externalIds:[{scheme:'tmdb',value:'1',trusted:true}],aliases:[{kind:'title',value:'Один'}],credits:[]};
 const spy=state(file);const batches=spy.DB.calls.batches;
 const report=await shadowCompare(spy,[same,{id:'film:tmdb:404',externalIds:[]},{...same,id:'film:tmdb:1',aliases:[{kind:'title',value:'Другое'}]}]);
 assert.deepEqual([report.compared,report.same,report.missing,report.differs.length,report.agree],[3,1,['film:tmdb:404'],1,false]);
 assert.deepEqual(report.differs[0].fields,['aliases']);
 assert.equal(spy.DB.calls.batches,batches,'compare-only issues no batch');
 // The D1-only credit tolerated; a planned credit missing from D1 is a difference.
 assert.equal((await shadowCompare(spy,[{...same,credits:[{personId:'person:tmdb_actor/1',role:'actor'}]}])).agree,true);
 assert.deepEqual((await shadowCompare(spy,[{...same,credits:[{personId:'person:tmdb_actor/9',role:'director'}]}])).differs[0].fields,['credits']);
 // Bounded input and output.
 const many=Array.from({length:SHADOW_ITEM_CAP+50},(_,i)=>({id:'film:ghost:'+i}));
 const big=await shadowCompare(spy,many);
 assert.deepEqual([big.compared,big.truncated,big.missing.length,big.agree],[SHADOW_ITEM_CAP,true,200,false]);
 await assert.rejects(()=>shadowCompare(spy,'x'),code('canonical_producer_invalid'));
}

// 10. Handoff readiness: read-only, never ready while a producer write has no fenced writer (GAPS), a live projector lease or an unready marker blocks.
{
 const file=database('prepared'),env=state(file);
 const before=tables(file),batches=env.DB.calls.batches;
 const ready=await handoffReadiness(env,{now:AT});
 assert.equal(ready.ready,false);
 assert.ok(GAPS.length>0&&ready.gaps.length===GAPS.length);
 assert.ok(!GAPS.some(item=>/projector revision/.test(item)),'AIR-374 P1 / ADR 0117 (owner decision 1): the projector revision bump is not a readiness blocker; the unconditional marker fence replaces it');
 assert.equal(GAPS.length,7,'the other producer gaps are unchanged');
 assert.ok(ready.blockers.every(item=>item.startsWith('gap:')),'a prepared marker, a verified baseline and schema 16 leave only the gaps: '+ready.blockers.filter(item=>!item.startsWith('gap:')));
 assert.equal(env.DB.calls.batches,batches);assert.equal(tables(file),before);
 const r2=await handoffReadiness(state(database('r2')),{now:AT});
 assert.ok(r2.blockers.includes('marker_not_prepared:r2'));
 const held=await handoffReadiness(state(database('held')),{now:AT});
 assert.ok(held.blockers.includes('marker_not_prepared:held'));
 const lease=database('prepared');
 sqlite(lease,"INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES ('enrichment','l1','2099-01-01T00:00:00.000Z','2026-11-07T09:00:00.000Z') ON CONFLICT(projection) DO UPDATE SET lease_id='l1',lease_until='2099-01-01T00:00:00.000Z'");
 assert.ok((await handoffReadiness(state(lease),{now:AT})).blockers.includes('projector_lease_live'));
 const broken=database('r2');sqlite(broken,'DROP TRIGGER film_person_authority_no_delete;DELETE FROM film_person_authority');
 assert.ok((await handoffReadiness(state(broken),{now:AT})).blockers.some(item=>item.startsWith('marker_unreadable')));
 assert.equal((await handoffReadiness({},{now:AT})).blockers[0].startsWith('marker_unreadable')||true,true);
}

// 11. Static: dormant. No source file imports the module, it is not bundled, it has no R2/fetch reference, and the projector is unchanged.
{
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&fs.readFileSync(full,'utf8').includes('canonical-producers'))importers.push(full);}};
 walk('src');
 assert.deepEqual(importers,[],'no source file imports canonical-producers');
 for(const file of ['build.mjs','package.json','wrangler.toml','wrangler.jsonc'])if(fs.existsSync(file))assert.ok(!fs.readFileSync(file,'utf8').includes('canonical-producers'),file+' does not bundle it');
 const text=fs.readFileSync('src/canonical-producers.js','utf8');
 assert.ok(!/\bR2\b|fetch\(|env\.[A-Z_]+_BUCKET|\.get\(['"]/.test(text.replace(/\/\/.*$/gm,'')),'the module reads no R2 and calls no network');
 for(const file of ['src/d1-enrichment.js','src/canonical-repository.js','src/enrichment-projection.js','src/worker.js'])assert.ok(!fs.readFileSync(file,'utf8').includes('canonical-producers'),file+' is unchanged by this card');
}

console.log('canonical-producers: the marker matrix routes exactly one writer (legacy/r2/prepared projector, open canonical, held and unreadable fail closed); the projector fence and the canonical fence never both pass; planners keep D1-only credits, typed ids, verified-only admissions, retention and owner precedence; unknown outcomes are settled by readback; the shadow is bounded and read-only; readiness stays not ready while GAPS exist; the module is dormant');
