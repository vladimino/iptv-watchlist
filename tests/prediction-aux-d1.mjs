// AIR-553 / ADR 0194: the dormant auxiliary prediction state in D1 (held stage, run sources, manifest, event outbox) over the real migrations in a sqlite D1 stand-in.
// Local stand-ins only; nothing here calls Cloudflare or production.
import assert from 'node:assert/strict';
import {migrated,sql} from './prediction-d1-flow-lib.mjs';
import {d1Standin} from './d1-standin.mjs';
import * as Aux from '../src/prediction-aux-d1.js';

const stamp='2026-11-22T10:00:00.000Z';
const GUARD={runId:'r1',epoch:1,token:null};
const count=(w,table)=>Number(sql(w.file,'SELECT count(*) AS n FROM '+table)[0].n);
function world({flip=true}={}){
 const file=migrated();
 sql(file,"UPDATE prediction_domain_authority SET mode='d1' WHERE id=1");
 if(flip){sql(file,"UPDATE prediction_aux_authority SET mode='closed', generation=1 WHERE id=1");sql(file,"UPDATE prediction_aux_authority SET mode='d1', generation=2, activated_at='"+stamp+"' WHERE id=1");};
 const calls={queries:[],batches:0};
 const db=d1Standin(file,{onQuery:text=>calls.queries.push(text),onBatch:statements=>{calls.batches++;for(const item of statements)calls.queries.push(item.text);}});
 const authority={mode:'d1',generation:flip?2:0};
 sql(file,"INSERT OR REPLACE INTO prediction_lease (name,token,expires_at,document_json) VALUES ('runner','tk0',"+(Date.now()+3600000)+",'"+JSON.stringify({runId:'r1',epoch:1})+"')");
 return {file,db,calls,authority};
}
const refuses=async(code,work)=>{try{await work();}catch(error){assert.equal(error.code??error.message,code);return;}assert.fail('expected '+code);};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// ---- 1. Authority: four outcomes, an unavailable authority is never r2 ----
{
 const w=world({flip:false});
 assert.deepEqual({...await Aux.readAuxAuthority(w.db,{PREDICTION_DB_REQUIRED:'on'})},{mode:'r2',proof:'explicit_r2',installed:true,generation:0,version:52,ready:false},'migrated marker reads explicit r2');
 assert.equal(await Aux.auxD1(w.db,{PREDICTION_DB_REQUIRED:'on'}),null,'r2 gives no D1 branch');
 const d=world();
 const live=await Aux.readAuxAuthority(d.db,{PREDICTION_DB_REQUIRED:'on'});
 assert.equal(live.mode,'d1');assert.equal(live.proof,'d1');assert.equal(live.generation,2);
 // proved not installed: a schema version below the migration (the version comes from the caller's own read, no extra D1 call)
 const none=await Aux.readAuxAuthority({prepare(){throw new Error('must not be asked');}},{PREDICTION_DB_REQUIRED:'on'},{version:33});
 assert.equal(none.proof,'not_installed');assert.equal(none.mode,'r2');
 // unavailable is never r2
 await refuses('prediction_aux_unavailable',()=>Aux.readAuxAuthority(null,{PREDICTION_DB_REQUIRED:'on'}));
 await refuses('prediction_aux_unavailable',()=>Aux.readAuxAuthority({prepare:()=>{throw new Error('binding down');},batch:()=>{throw new Error('down');}},{PREDICTION_DB_REQUIRED:'on'}));
 const partial={prepare:sqlText=>({bind:()=>({first:async()=>null,all:async()=>({results:/sqlite_master/.test(sqlText)?[{name:'prediction_aux_authority'}]:[]})}),first:async()=>null,all:async()=>({results:[]})})};
 await refuses('prediction_aux_unavailable',()=>Aux.readAuxAuthority(partial,{PREDICTION_DB_REQUIRED:'on'},{version:34}));
 const noRow={prepare:sqlText=>({bind:()=>({first:async()=>null,all:async()=>({results:/sqlite_master/.test(sqlText)?Aux.AUX_LIMITS&&['prediction_aux_authority','prediction_aux_cas','prediction_batch_stage_head','prediction_batch_stage','prediction_run_source_head','prediction_run_source_revision','prediction_run_source_piece','prediction_run_manifest','prediction_run_manifest_piece','prediction_event_outbox','prediction_event_outbox_counter','prediction_event_outbox_state_count','prediction_event_outbox_diag'].map(name=>({name})):[]})}),first:async()=>null,all:async()=>({results:[]})})};
 await refuses('prediction_aux_unavailable',()=>Aux.readAuxAuthority(noRow,{PREDICTION_DB_REQUIRED:'on'},{version:34}));
 // d1 -> r2 and a delete of the marker are refused by the database, a generation never goes down
 const t=sqlText=>{try{sql(d.file,sqlText);return 'ok';}catch(error){return String(error.message);}};
 assert.match(t("UPDATE prediction_aux_authority SET mode='r2', activated_at=NULL"),/prediction_aux_authority_(one_way|chain)/);
 assert.match(t('DELETE FROM prediction_aux_authority'),/prediction_aux_authority_keep/);
 assert.match(t('UPDATE prediction_aux_authority SET generation=0'),/prediction_aux_authority_(one_way|chain)/);
}

// ---- 2. Held stage: rows, aggregate cap on the head, CAS on the revision ----
{
 const w=world();
 const measure=item=>new TextEncoder().encode(JSON.stringify({filmId:item.filmId,body:item.body})).length;
 const item=(id,body='x')=>({filmId:id,itemDigest:'digest-'+id,body,origin:{runId:'r1'},stagedAt:stamp});
 const add=(items,opts={})=>Aux.mergeStage(w.db,w.authority,cur=>({items:[...cur.items,...items],updatedAt:stamp}),{measure,guard:GUARD,...opts});
 await add([item('a'),item('b')]);
 let stage=await Aux.readStage(w.db);
 assert.deepEqual(stage.items.map(i=>i.filmId),['a','b']);assert.equal(stage.itemCount,2);assert.equal(stage.revision,1);
 assert.equal(stage.totalBytes,Aux.stageDocBytes(stage.items.map(measure)),'the head carries the serialized aggregate');
 // no change (apply returns null) writes nothing
 const revBefore=(await Aux.readStage(w.db)).revision;await Aux.mergeStage(w.db,w.authority,()=>null,{measure,guard:GUARD});assert.equal((await Aux.readStage(w.db)).revision,revBefore,'no change writes nothing');
 // removal keeps order of the rest; a new row goes to the end
 await Aux.mergeStage(w.db,w.authority,cur=>({items:cur.items.filter(i=>i.filmId!=='a'),updatedAt:stamp}),{measure,guard:GUARD});
 await add([item('c')]);
 stage=await Aux.readStage(w.db);assert.deepEqual(stage.items.map(i=>i.filmId),['b','c']);
 // item count: the 11th is refused by the budget and nothing lands
 const full=world();
 await Aux.mergeStage(full.db,full.authority,cur=>({items:Array.from({length:10},(_,n)=>item('f'+n)),updatedAt:stamp}),{measure,guard:GUARD});
 await refuses('prediction_aux_budget',()=>Aux.mergeStage(full.db,full.authority,cur=>({items:[...cur.items,item('f10')],updatedAt:stamp}),{measure,guard:GUARD}));
 assert.equal((await Aux.readStage(full.db)).itemCount,10);
 // aggregate byte cap: exactly the cap passes, one byte more is refused; 10 rows are NOT each allowed the whole cap
 const cap=Aux.AUX_LIMITS.stageBytes,overhead=measure(item('big',''));
 const bytesOf=n=>({items:[item('big','y'.repeat(n))]});
 const edge=world();
 const fit=cap-2-overhead;
 await Aux.mergeStage(edge.db,edge.authority,()=>({...bytesOf(fit),updatedAt:stamp}),{measure,guard:GUARD});
 assert.equal((await Aux.readStage(edge.db)).totalBytes,cap,'exactly the cap');
 const over=world();
 await refuses('prediction_aux_budget',()=>Aux.mergeStage(over.db,over.authority,()=>({...bytesOf(fit+1),updatedAt:stamp}),{measure,guard:GUARD}));
 assert.equal((await Aux.readStage(over.db)).itemCount,0,'an over-cap write leaves nothing');
 await refuses('prediction_aux_budget',()=>Aux.mergeStage(edge.db,edge.authority,cur=>({items:[...cur.items,item('two','z'.repeat(20))],updatedAt:stamp}),{measure,guard:GUARD}));
 // concurrent insertion: both writers read revision N; the second commits first; the first's batch fails the head CAS, re-reads, applies again and lands
 const race=world();let release,entered=0;const gate=new Promise(resolve=>{release=resolve;});
 const first=Aux.mergeStage(race.db,race.authority,async cur=>{entered++;if(entered===1)await gate;return {items:[...cur.items,item('p')],updatedAt:stamp};},{measure,guard:GUARD});
 await sleep(200);
 await Aux.mergeStage(race.db,race.authority,cur=>({items:[...cur.items,item('q')],updatedAt:stamp}),{measure,guard:GUARD});
 release();await first;
 assert.deepEqual((await Aux.readStage(race.db)).items.map(i=>i.filmId).sort(),['p','q'],'both writers landed, one after a re-read');
 assert.ok(entered>=2,'the loser re-read and applied again');
 // exact drop: the caller deletes the rows it OBSERVED (film, digest, holder); a replacement hold of the same film stays
 {
  const x=world();const put=(id,digest,holder='r1')=>Aux.mergeStage(x.db,x.authority,cur=>({items:[...cur.items.filter(i=>i.filmId!==id),{...item(id),itemDigest:digest,origin:{runId:holder}}],updatedAt:stamp}),{measure,guard:GUARD});
  await put('a','digest-A');await put('b','digest-B1');
  const observed=(await Aux.readStage(x.db)).observed;
  assert.deepEqual(observed.map(o=>[o.filmId,o.itemDigest,o.heldByRunId]),[['a','digest-A','r1'],['b','digest-B1','r1']]);
  await put('b','digest-B2');                                   // a newer hold of b arrives after the observation
  assert.equal(await Aux.dropStageRows(x.db,x.authority,observed,{guard:GUARD}),2);
  const after=await Aux.readStage(x.db);
  assert.deepEqual(after.items.map(i=>[i.filmId,i.itemDigest]),[['b','digest-B2']],'the observed rows went, the replacement stayed');
  assert.equal(after.itemCount,1);assert.equal(after.totalBytes,Aux.stageDocBytes(after.items.map(measure)),'the head is recomputed from the rows');
  // the same film held by another run is not the observed row either
  await put('c','digest-C','other-run');
  await Aux.dropStageRows(x.db,x.authority,[{filmId:'c',itemDigest:'digest-C',heldByRunId:'r1'}],{guard:GUARD});
  assert.equal((await Aux.readStage(x.db)).items.length,2,'a different holder is a different row');
  await refuses('prediction_aux_guard',()=>Aux.dropStageRows(x.db,x.authority,observed));
  // the settle statements of a drain carry the holder too
  const settle=Aux.stageSettleStatements(x.authority,'b','digest-B1','r1');
  assert.match(settle[1][0],/held_by_run_id IS \?/);
  // one snapshot, checked: a head that disagrees with its rows is corruption, not a blend of two moments
  sql(x.file,'UPDATE prediction_batch_stage_head SET item_count=5');
  await refuses('prediction_aux_corrupt',()=>Aux.readStage(x.db));
 }
 // a stale marker generation cannot write: nothing lands
 await refuses('Stored JSON changed during write',()=>Aux.mergeStage(race.db,{mode:'d1',generation:0},cur=>({items:[...cur.items,item('late')],updatedAt:stamp}),{measure,guard:GUARD}));
 assert.equal((await Aux.readStage(race.db)).itemCount,2);
 // a run-owned write needs its live lease: without a lease row the guard fails closed
 await refuses('Stored JSON changed during write',()=>Aux.mergeStage(race.db,race.authority,cur=>({items:[...cur.items,item('owned')],updatedAt:stamp}),{measure,guard:{runId:'r1',epoch:1,token:'t'}}));
}

// ---- 3. Sources: insert-only revisions, CAS head, binding to the run, history kept ----
{
 const w=await world_();
 const lease=(runId,epoch,token)=>sql(w.file,"INSERT OR REPLACE INTO prediction_lease (name,token,expires_at,document_json) VALUES ('runner','tk',"+(Date.now()+600000)+",'"+JSON.stringify({runId,epoch,...(token?{submitGate:{token}}:{})})+"')");
 const run=(runId,doc={})=>sql(w.file,"INSERT OR REPLACE INTO prediction_run (run_id,latest,updated_at,document_json) VALUES ('"+runId+"',0,'"+stamp+"','"+JSON.stringify({runId,protocol:'batch_v2',...doc}).replace(/'/g,"''")+"')");
 const g=(runId,epoch=1,token=null)=>({runId,epoch,token});
 lease('run1',1,null);run('run1');
 const one=await Aux.writeSource(w.db,w.authority,'run1',{f1:{title:'A'}},{guard:g('run1')});
 assert.deepEqual([one.revision,one.written],[1,true]);
 assert.equal((await Aux.writeSource(w.db,w.authority,'run1',{f1:{title:'A'}},{guard:g('run1')})).written,false,'an identical document writes nothing');
 const two=await Aux.writeSource(w.db,w.authority,'run1',{f1:{title:'A'},f2:{title:'B'}},{guard:g('run1')});assert.equal(two.revision,2);
 const current=await Aux.readSource(w.db,'run1');assert.deepEqual(Object.keys(current.value),['f1','f2']);assert.equal(current.revision,2);
 assert.equal((await Aux.listSourceRevisions(w.db,'run1')).length,2,'every historical revision stays');
 const old=sql(w.file,"SELECT text FROM prediction_run_source_piece WHERE run_id='run1' AND revision=1");assert.deepEqual(JSON.parse(old[0].text),{f1:{title:'A'}},'revision 1 still holds the original model input');
 await refuses('prediction_aux_conflict',()=>Aux.writeSource(w.db,w.authority,'run1',{f1:{title:'CHANGED'},f2:{title:'B'}},{guard:g('run1')}));
 await refuses('prediction_aux_conflict',()=>Aux.writeSource(w.db,w.authority,'run1',{f1:{title:'A'}},{guard:g('run1')}));
 for(const bad of ["UPDATE prediction_run_source_piece SET text='x'","DELETE FROM prediction_run_source_piece","UPDATE prediction_run_source_revision SET bytes=0","DELETE FROM prediction_run_source_revision","UPDATE prediction_run_source_head SET current_revision=1","DELETE FROM prediction_run_source_head"])assert.throws(()=>sql(w.file,bad),/prediction_aux_immutable/,bad);
 // a revision race: two writers extend revision 2; exactly one takes revision 3, the other fails closed and writes nothing
 const [x,y]=await Promise.allSettled([Aux.writeSource(w.db,w.authority,'run1',{f1:{title:'A'},f2:{title:'B'},f3:{}},{guard:g('run1')}),Aux.writeSource(w.db,w.authority,'run1',{f1:{title:'A'},f2:{title:'B'},f4:{}},{guard:g('run1')})]);
 assert.equal([x,y].filter(r=>r.status==='fulfilled').length,1);assert.equal((await Aux.readSource(w.db,'run1')).revision,3);
 // the binding: a run that carries a sourceRevision/sourceHash must match the head; another value is corruption, never input; a run without a binding is a legacy run
 run('run1',{sourceRevision:3,sourceHash:(await Aux.readSource(w.db,'run1')).hash});assert.equal((await Aux.readSource(w.db,'run1')).revision,3);
 run('run1',{sourceRevision:2,sourceHash:(await Aux.readSource(w.db,'run1')).hash});await refuses('prediction_aux_corrupt',()=>Aux.readSource(w.db,'run1'));
 run('run1',{sourceRevision:3,sourceHash:'f'.repeat(64)});await refuses('prediction_aux_corrupt',()=>Aux.readSource(w.db,'run1'));
 run('run1');assert.equal((await Aux.readSource(w.db,'run1')).revision,3,'a run document without a binding is a legacy or imported run');
 sql(w.file,"DELETE FROM prediction_run WHERE run_id='run1'");await refuses('prediction_aux_corrupt',()=>Aux.readSource(w.db,'run1'));
 // composed with the run write: the plan carries the revision statements for the run's own batch (no write of its own)
 const planned=await Aux.planSource(w.db,w.authority,'run9',{f1:{}});assert.equal(planned.written,true);assert.equal(planned.revision,1);assert.equal(count(w,'prediction_run_source_head'),1,'a plan writes nothing');
 // bytes and pieces: a large text is cut by bytes, never inside a surrogate pair, and reads back whole and verified
 lease('run2',1,null);run('run2');
 const big={};for(let i=0;i<40;i++)big['film'+i]={synopsis:'🎬ёж'.repeat(900)+i};
 const pieces=Aux.splitPieces(JSON.stringify(big),8000);
 assert.ok(pieces.length>3);assert.equal(pieces.join(''),JSON.stringify(big));
 for(const piece of pieces){assert.ok(!/[\uD800-\uDBFF]$/.test(piece)&&!/^[\uDC00-\uDFFF]/.test(piece),'no split pair');}
 await Aux.writeSource(w.db,w.authority,'run2',big,{guard:g('run2')});
 assert.deepEqual((await Aux.readSource(w.db,'run2')).value,big);
 const statementMax=Math.max(...sql(w.file,"SELECT length(text) AS n FROM prediction_run_source_piece WHERE run_id='run2'").map(r=>r.n));assert.ok(statementMax<=Aux.AUX_LIMITS.pieceChars);
 sql(w.file,"DROP TRIGGER prediction_run_source_piece_no_update");sql(w.file,"UPDATE prediction_run_source_piece SET text=replace(text,'ёж','ee') WHERE run_id='run2' AND piece_no=0");
 await refuses('prediction_aux_corrupt',()=>Aux.readSource(w.db,'run2'));
 // the lease fence of a run-owned source write: a token that is not the gate's, another epoch, no fence at all, an incomplete fence: nothing is written and nothing is silently weakened
 lease('run3',2,'good');
 await refuses('prediction_aux_cas',()=>Aux.writeSource(w.db,w.authority,'run3',{f1:{}},{guard:g('run3',2,'bad')}));
 await refuses('prediction_aux_cas',()=>Aux.writeSource(w.db,w.authority,'run3',{f1:{}},{guard:g('run3',3,'good')}));
 await refuses('prediction_aux_guard',()=>Aux.writeSource(w.db,w.authority,'run3',{f1:{}}));
 await refuses('prediction_aux_guard',()=>Aux.writeSource(w.db,w.authority,'run3',{f1:{}},{guard:{runId:'run3',epoch:'2',token:'good'}}));
 await refuses('prediction_aux_guard',()=>Aux.writeSource(w.db,w.authority,'run3',{f1:{}},{guard:{epoch:2,token:'good'}}));
 assert.equal(count(w,'prediction_run_source_head'),2,'the refused run3 attempts left nothing (run1 and run2 only)');
 run('run3');
 assert.equal((await Aux.writeSource(w.db,w.authority,'run3',{f1:{}},{guard:g('run3',2,'good')})).written,true);
 // keyless preparation: no token, the run's own lease (id, epoch, expiry) is the fence
 lease('run3',2,null);
 assert.equal((await Aux.writeSource(w.db,w.authority,'run3',{f1:{},f2:{}},{guard:g('run3',2,null)})).written,true);
 // prediction domain: the existing predicate is mode d1 (the `writes` column is `held` in production and is not part of it, ADR 0162): held writes pass, a domain not in d1 does not
 sql(w.file,"UPDATE prediction_domain_authority SET writes='held' WHERE id=1");
 assert.equal((await Aux.writeSource(w.db,w.authority,'run3',{f1:{},f2:{},f3:{}},{guard:g('run3',2,null)})).written,true,'writes=held is the production state of the prediction domain and is accepted');
}
function world_(){return world();}
// ---- 4. Manifest: create-only, exact digest, per-piece digests, bounded part reads ----
{
 const w=world();
 sql(w.file,"INSERT OR REPLACE INTO prediction_lease (name,token,expires_at,document_json) VALUES ('runner','tk',"+(Date.now()+600000)+",'"+JSON.stringify({runId:'m1',epoch:1,submitGate:{token:'g'}})+"')");
 sql(w.file,"INSERT INTO prediction_run (run_id,latest,updated_at,document_json) VALUES ('m1',1,'"+stamp+"','"+JSON.stringify({runId:'m1',protocol:'batch_v2'})+"')");
 const films=Array.from({length:30},(_,n)=>({filmId:'tmdb_'+n,lane:'cold',plan:'prediction_only',modelMetadata:{title:'Фильм '+n,synopsis:'🎬 '.repeat(1500)}}));
 const answer={status:'running',runId:'m1',protocol:'batch_v2',lease:{epoch:1,ttlMs:900000},manifestHash:'a'.repeat(64),films,profile:{version:1,hash:'p',body:{a:1}},contract:{x:{y:1}},drained:{committed:1,committedIds:['tmdb_old']},dryRun:false};
 const guard={runId:'m1',epoch:1,token:'g'};
 const out=await Aux.writeManifest(w.db,w.authority,'m1',answer,{guard});
 assert.equal(out.written,true);
 // the whole answer reassembles in its original key order and verifies against the exact payload digest
 const whole=await Aux.readManifest(w.db,'m1');
 assert.equal(JSON.stringify(whole),JSON.stringify(answer),'exact bytes and key order');
 assert.equal(out.payloadDigest,await Aux.sha256(JSON.stringify(answer)));
 // replay: same bytes are a no-op, other bytes are a conflict, never an overwrite
 assert.equal((await Aux.writeManifest(w.db,w.authority,'m1',answer,{guard})).written,false);
 await refuses('prediction_aux_conflict',()=>Aux.writeManifest(w.db,w.authority,'m1',{...answer,films:answer.films.slice(1)},{guard}));
 for(const bad of ["UPDATE prediction_run_manifest SET bytes=1","DELETE FROM prediction_run_manifest","UPDATE prediction_run_manifest_piece SET text='x'","DELETE FROM prediction_run_manifest_piece"])assert.throws(()=>sql(w.file,bad),/prediction_aux_immutable/,bad);

 // part identity: the stored run id and epoch travel with the manifest (the readers compare them to the durable run)
 assert.deepEqual((await Aux.readManifestPart(w.db,'m1','profile')).meta,{runId:'m1',epoch:1});
 // a replay is accepted only after the STORED BYTES verify: the same digest over altered bytes is corruption, not a replay
 sql(w.file,"DROP TRIGGER IF EXISTS prediction_run_manifest_piece_no_update");
 const piece0=sql(w.file,"SELECT text FROM prediction_run_manifest_piece WHERE run_id='m1' AND piece_no=0")[0].text;
 sql(w.file,"UPDATE prediction_run_manifest_piece SET text='"+piece0.replace(/'/g,"''").replace('Фильм 0','Фильм X')+"' WHERE run_id='m1' AND piece_no=0");
 await refuses('prediction_aux_corrupt',()=>Aux.writeManifest(w.db,w.authority,'m1',answer,{guard}));
 sql(w.file,"UPDATE prediction_run_manifest_piece SET text='"+piece0.replace(/'/g,"''")+"' WHERE run_id='m1' AND piece_no=0");
 assert.equal((await Aux.writeManifest(w.db,w.authority,'m1',answer,{guard})).written,false,'with the original bytes restored the replay is a no-op again');
 // a part read fetches only the pieces that cover it (not the whole body, not other runs)
 const total=Number(sql(w.file,"SELECT piece_count AS n FROM prediction_run_manifest WHERE run_id='m1'")[0].n);assert.ok(total>=3,'the manifest spans several pieces');
 w.calls.queries.length=0;
 const film=await Aux.readManifestPart(w.db,'m1','film','tmdb_29');
 assert.deepEqual(film.value,films[29]);
 const covering=w.calls.queries.filter(q=>/json_each\(json_extract\(m\.part_index/.test(q));assert.equal(covering.length,1,'one batch read the row and the covering pieces');
 const covered=sql(w.file,covering[0]);assert.ok(covered.length>=1&&covered.length<total,'fewer pieces than the whole body: '+covered.length+' of '+total);
 assert.ok(!w.calls.queries.some(q=>/FROM prediction_run_manifest_piece WHERE run_id='m1'(?! AND)/.test(q)&&!/json_each/.test(q)),'no read of the whole body');
 const env=await Aux.readManifestPart(w.db,'m1','envelope');
 assert.deepEqual(env.filmIds,films.map(f=>f.filmId));assert.equal(env.envelope.manifestHash,answer.manifestHash);assert.deepEqual(env.drained,answer.drained);assert.ok(!('films' in env.envelope));
 assert.deepEqual((await Aux.readManifestPart(w.db,'m1','profile')).value,answer.profile);
 assert.equal(await Aux.readManifestPart(w.db,'m1','film','nope'),undefined);assert.equal(await Aux.readManifestPart(w.db,'nope','film','x'),null);
 // partial corruption: one piece is altered; the parts it does not cover still verify, the covered one fails closed
 sql(w.file,"DROP TRIGGER IF EXISTS prediction_run_manifest_piece_no_update");
 sql(w.file,"UPDATE prediction_run_manifest_piece SET text=substr(text,1,10)||'#'||substr(text,12) WHERE run_id='m1' AND piece_no="+(total-1));
 await refuses('prediction_aux_corrupt',()=>Aux.readManifestPart(w.db,'m1','film','tmdb_29'));
 assert.deepEqual((await Aux.readManifestPart(w.db,'m1','profile')).value,answer.profile,'an uncovered part still verifies');
 await refuses('prediction_aux_corrupt',()=>Aux.readManifest(w.db,'m1'));
 // readiness is atomic with the manifest: extra statements commit in the same batch; a failing guard writes neither
 const w2=world();
 sql(w2.file,"INSERT OR REPLACE INTO prediction_lease (name,token,expires_at,document_json) VALUES ('runner','tk',"+(Date.now()+600000)+",'"+JSON.stringify({runId:'m2',epoch:1,submitGate:{token:'g'},prep:true})+"')");
 sql(w2.file,"INSERT INTO prediction_run (run_id,latest,updated_at,document_json) VALUES ('m2',1,'"+stamp+"','"+JSON.stringify({runId:'m2',protocol:'batch_v2'})+"')");
 const ready=["UPDATE prediction_lease SET document_json=json_remove(document_json,'$.prep') WHERE name='runner'",[]];
 await refuses('prediction_aux_cas',()=>Aux.writeManifest(w2.db,w2.authority,'m2',{...answer,runId:'m2'},{guard:{runId:'m2',epoch:1,token:'wrong'},extra:[ready]}));
 assert.equal(await Aux.readManifestPart(w2.db,'m2','profile'),null,'a refused ready wrote no manifest');
 assert.equal(JSON.parse(sql(w2.file,"SELECT document_json AS d FROM prediction_lease")[0].d).prep,true,'and did not clear the preparation mark');
 await Aux.writeManifest(w2.db,w2.authority,'m2',{...answer,runId:'m2'},{guard:{runId:'m2',epoch:1,token:'g'},extra:[ready]});
 assert.equal(JSON.parse(sql(w2.file,"SELECT document_json AS d FROM prediction_lease")[0].d).prep,undefined,'the manifest and the ready edit landed together');
 // a run whose row is not a batch_v2 run cannot take a manifest
 sql(w2.file,"UPDATE prediction_run SET document_json='{\"runId\":\"m2\",\"protocol\":\"other\"}'");
 await refuses('prediction_aux_cas',()=>Aux.writeManifest(w2.db,w2.authority,'m3',{...answer,runId:'m3'},{guard:{runId:'m2',epoch:1,token:'g'}}));
}

// ---- 5. Outbox: identity, replay, cap, quarantine, settlement, compaction ----
{
 const w=world();
 const event=(id,extra={})=>({id,type:'enrichment',at:stamp,stage:'skipped',...extra});
 const admit=(kind,identity,ev,extra={})=>Aux.admitOutbox(w.db,w.authority,{kind,identity,event:ev,journalKey:'events/items/'+identity+'.json',fence:'target',...extra});
 const a=await admit('skipped','req-1',event('enrichment-skipped-req-1'));
 assert.equal(a.admitted,true);assert.equal(a.row.state,'pending');assert.equal(a.row.at,stamp);
 const replay=await admit('skipped','req-1',event('enrichment-skipped-req-1',{at:'2030-01-01T00:00:00.000Z'}));
 assert.equal(replay.admitted,false);assert.equal(replay.row.at,stamp,'a replay keeps the first `at`');assert.equal(replay.row.journalKey,a.row.journalKey);
 // the cap: 255 more active pending rows (seeded in one script), then the 256th is admitted and the 257th refused
 const rows=[];for(let i=0;i<254;i++)rows.push("('skipped:s"+i+"','skipped','e"+i+"','"+stamp+"','j"+i+"',NULL,'pending',0,'"+stamp+"',NULL,NULL,'"+'b'.repeat(64)+"',0,'{}')");
 sql(w.file,"INSERT INTO prediction_event_outbox (event_key,kind,event_id,at,journal_key,run_id,state,attempts,since,last_attempt_at,settled_at,payload_digest,payload_compacted,event_json) VALUES "+rows.join(','));
 assert.equal((await Aux.outboxStatus(w.db)).skippedActivePending,255);
 assert.equal((await admit('skipped','req-256',event('enrichment-skipped-req-256'))).admitted,true);
 const refused=await admit('skipped','req-257',event('enrichment-skipped-req-257'));
 assert.equal(refused.admitted,false);assert.equal(refused.refused,'cap');
 assert.equal(await Aux.readOutboxRow(w.db,'skipped:req-257'),null,'a refused request leaves no row');
 let status=await Aux.outboxStatus(w.db);assert.equal(status.capRefusals,1);assert.equal(status.skippedActivePending,256);assert.ok(status.lastCapRefusalAt);
 // replay at capacity is still idempotent; a terminal (run-bound) event is not counted and is never refused
 assert.equal((await admit('skipped','req-1',event('enrichment-skipped-req-1'))).row.eventKey,'skipped:req-1');
 assert.equal((await admit('stop','run-9',event('enrichment-run-9',{stage:'complete'}),{runId:'run-9'})).admitted,true);
 assert.equal((await Aux.outboxStatus(w.db)).skippedActivePending,256,'terminal events are not counted');
 // quarantine frees a slot (it never starves new admissions); after the 8th failed delivery
 let row=await Aux.readOutboxRow(w.db,'skipped:s0');
 for(let n=0;n<8;n++){const state=await Aux.failOutbox(w.db,w.authority,row,{fence:'target'});row=await Aux.readOutboxRow(w.db,'skipped:s0');assert.equal(state,n===7?'quarantined':'pending');}
 assert.equal(row.attempts,8);assert.equal((await Aux.outboxStatus(w.db)).skippedActivePending,255,'quarantined rows leave the active count');
 assert.equal((await admit('skipped','req-257',event('enrichment-skipped-req-257'))).admitted,true,'a freed slot admits a new request');
 // a stale attempts read does not double-count (target compare-and-swap)
 const fresh=await Aux.readOutboxRow(w.db,'skipped:s1');await Aux.failOutbox(w.db,w.authority,fresh,{fence:'target'});await Aux.failOutbox(w.db,w.authority,fresh,{fence:'target'});
 assert.equal((await Aux.readOutboxRow(w.db,'skipped:s1')).attempts,1);
 // drain order: the latest run's rows first, then oldest first; quarantined rows never take a slot; bounded to 20
 const queue=await Aux.pendingOutbox(w.db,{runId:'run-9'});
 assert.equal(queue.length,20);assert.equal(queue[0].eventKey,'stop:run-9');assert.ok(!queue.some(r=>r.state==='quarantined'));
 // settle is monotone: delivered stays delivered, and a later superseded does not change it
 await Aux.settleOutbox(w.db,w.authority,'stop:run-9','delivered',{fence:'target'});
 let settled=await Aux.readOutboxRow(w.db,'stop:run-9');assert.equal(settled.state,'delivered');assert.ok(settled.settledAt);
 await Aux.settleOutbox(w.db,w.authority,'stop:run-9','superseded',{fence:'target',supersededRun:'run-9'});assert.equal((await Aux.readOutboxRow(w.db,'stop:run-9')).state,'delivered');
 assert.throws(()=>sql(w.file,"UPDATE prediction_event_outbox SET state='pending' WHERE event_key='stop:run-9'"),/prediction_aux_outbox_settled/);
 assert.throws(()=>sql(w.file,"DELETE FROM prediction_event_outbox WHERE event_key='stop:run-9'"),/prediction_aux_outbox_keep/);
 assert.throws(()=>sql(w.file,"UPDATE prediction_event_outbox SET at='2020-01-01T00:00:00.000Z' WHERE event_key='stop:run-9'"),/prediction_aux_outbox_identity/);
 // compaction: not before 14 days after settlement; then only the payload goes; the identity stays and the record is never rebuilt
 assert.equal(await Aux.compactSettled(w.db,w.authority,{now:()=>Date.parse(settled.settledAt)+13*86400000}),0);
 assert.equal(await Aux.compactSettled(w.db,w.authority,{now:()=>Date.parse(settled.settledAt)+14*86400000+1000}),1);
 const compact=await Aux.readOutboxRow(w.db,'stop:run-9');
 assert.equal(compact.compacted,true);assert.equal(compact.event,null);assert.equal(compact.at,stamp);assert.equal(compact.journalKey,settled.journalKey);assert.equal(compact.payloadDigest,settled.payloadDigest);
 const again=await admit('stop','run-9',event('enrichment-run-9',{stage:'complete'}),{runId:'run-9'});
 assert.equal(again.admitted,false);assert.equal(again.row.compacted,true,'a compacted identity is never re-enqueued');
 // pending and quarantined rows keep their payload however old
 assert.equal(await Aux.compactSettled(w.db,w.authority,{now:()=>Date.now()+400*86400000}),0);
 assert.ok((await Aux.readOutboxRow(w.db,'skipped:s0')).event,'a quarantined row keeps its payload');
 // a stale marker generation cannot admit
 await refuses('prediction_aux_cas',()=>Aux.admitOutbox(w.db,{mode:'d1',generation:0},{kind:'stop',identity:'run-x',event:event('x'),journalKey:'j',fence:'target'}));
 // a write names its fence: none is a thrown error, never a silently weaker write
 await refuses('prediction_aux_guard',()=>Aux.admitOutbox(w.db,w.authority,{kind:'stop',identity:'run-y',event:event('y'),journalKey:'j'}));
 await refuses('prediction_aux_guard',()=>Aux.settleOutbox(w.db,w.authority,'skipped:req-1','delivered'));
 await refuses('prediction_aux_guard',()=>Aux.admitOutbox(w.db,w.authority,{kind:'stop',identity:'run-z',event:event('z'),journalKey:'j',fence:'writer'}));
 // supersession is decided against the TARGET run's own row in the same snapshot, not against an earlier read
 await admit('stop','run-s',event('enrichment-run-s',{stage:'partial'}),{runId:'run-s'});
 await Aux.settleOutbox(w.db,w.authority,'stop:run-s','superseded',{fence:'target',supersededRun:'run-s'});
 assert.equal((await Aux.readOutboxRow(w.db,'stop:run-s')).state,'pending','a run that nobody recovered cannot have its stop superseded');
 sql(w.file,"INSERT OR REPLACE INTO prediction_run (run_id,latest,updated_at,document_json) VALUES ('run-s',0,'"+stamp+"','"+JSON.stringify({runId:'run-s',recoveredByRunId:'run-t'})+"')");
 await Aux.settleOutbox(w.db,w.authority,'stop:run-s','superseded',{fence:'target',supersededRun:'run-s'});
 assert.equal((await Aux.readOutboxRow(w.db,'stop:run-s')).state,'superseded','once the target run carries recoveredByRunId, the stop is superseded');
 await refuses('prediction_aux_conflict',()=>Aux.settleOutbox(w.db,w.authority,'stop:run-s','superseded',{fence:'target'}));
 // the writer guard: only the holder of the live writer lease may deliver under it
 sql(w.file,"INSERT OR REPLACE INTO prediction_lease (name,token,expires_at,document_json) VALUES ('writer','wt',"+(Date.now()+60000)+",'"+JSON.stringify({id:'w-1'})+"')");
 await refuses('prediction_aux_cas',()=>Aux.settleOutbox(w.db,w.authority,'skipped:req-1','delivered',{writer:'w-other'}));
 await Aux.settleOutbox(w.db,w.authority,'skipped:req-1','delivered',{writer:'w-1'});assert.equal((await Aux.readOutboxRow(w.db,'skipped:req-1')).state,'delivered');
}
console.log('prediction aux d1: ok');
