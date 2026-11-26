// AIR-666 / ADR 0218 stage 6 (decision 7): the guarded retirement of legacy `film_dimension` copy rows with a pre-image (code only), on real SQLite (the sqlite3-CLI D1 stand-in).
// No Worker, R2 or Cloudflare access, no production invocation: the module is dormant and these fixtures are its only caller.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {readDimensionParity} from '../src/film-dimension-parity.js';

const load=name=>import(pathToFileURL(path.resolve('src',name)).href);
const R=await load('film-dimension-retirement.js');
const {protectedReasons}=await load('canonical-repository.js');
const {OPERATION_KINDS}=await load('canonical-receipts.js');

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-dimension-retirement-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const exec=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});assert.equal(r.status,0,r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const template=path.join(root,'template.sqlite');
exec(template,fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:00.000Z');";
let n=0;
function database({held=false}={}){
 const file=path.join(root,'r-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 exec(file,"UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;"+BASELINE);
 exec(file,"UPDATE prediction_domain_authority SET mode='d1',generation=1 WHERE id=1;UPDATE owner_review_authority SET mode='d1',generation=1 WHERE id=1;");
 if(held)exec(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1;");
 return file;
}
const q=value=>value==null?'NULL':typeof value==='number'?String(value):"'"+String(value).replace(/'/g,"''")+"'";
const code=expected=>error=>{assert.equal(error.code,expected,error.stack);return true;};
const T='2026-11-25T10:00:00.000Z',T3='2026-11-25T13:00:00.000Z';
const insert=(table,row)=>`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.values(row).map(q).join(',')});`;
const STATUS={identity:'resolved',metadata:'fresh',localization:'provisional',fingerprint:'current',prediction:'current'};
const dim=(film_id,dimension,over={})=>insert('film_dimension',{film_id,dimension,status:STATUS[dimension],source:null,source_version:null,provenance_json:null,value:null,authority:null,last_error:null,failure_reason:null,retry_at:null,attempts:0,next_action:'none',updated_at:T,...over});
const meta=film_id=>insert('film_metadata',{film_id,schema_version:1,year:1999,runtime:120,synopsis:'Text',poster:'https://p/x.jpg',url:'https://example.test/x',genres_json:'["Drama"]',people_version:null,payload_json:'{}',r2_key:null,content_sha256:null,updated_at:T});
// A Film whose identity passes the fence and whose three retirable rows are plain stale copies: proof is complete under complete coverage.
const copyFilm=(file,id,tmdb,over={})=>exec(file,[
 insert('film',{id,contract_version:1,canonical_identity:'tmdb:'+tmdb,original_title:'Title '+tmdb,updated_at:T}),
 insert('film_external_id',{film_id:id,scheme:'tmdb',value:tmdb,trusted:1,conflicting:0,provenance_json:null}),
 meta(id),
 dim(id,'identity'),dim(id,'metadata',over.metadata),dim(id,'fingerprint',over.fingerprint),dim(id,'prediction',over.prediction),
 dim(id,'localization',{status:'missing'}),
].join('\n'));
const revision=(file,id)=>Number(one(file,"SELECT COALESCE((SELECT revision FROM canonical_revision WHERE kind='film' AND id="+q(id)+"),0)")??0);
const dimRows=(file,id)=>rows(file,"SELECT dimension,status,authority FROM film_dimension WHERE film_id="+q(id)+" ORDER BY dimension");
const names=(file,id)=>dimRows(file,id).map(row=>row.dimension);
const receipts=file=>rows(file,"SELECT request_id,operation,origin,target_id,state,applied_revision,planned_revision FROM canonical_write_receipt ORDER BY request_id");
const everything=file=>JSON.stringify([rows(file,"SELECT * FROM film_dimension ORDER BY film_id,dimension"),rows(file,"SELECT * FROM film ORDER BY id"),rows(file,"SELECT * FROM film_metadata ORDER BY film_id"),rows(file,"SELECT * FROM canonical_revision ORDER BY kind,id")]);
const coverage=()=>({status:'complete'});
const clock=()=>T3;
const memory=({failRecord=false,failSettle=false}={})=>{const log={records:[],settles:[]};return {log,record:async intent=>{if(failRecord)throw new Error('disk full');log.records.push(intent);},settle:async(intent,result)=>{if(failSettle)throw new Error('disk full');log.settles.push([intent,result]);}};};
const goOf=async list=>({reference:'https://example.test/owner-go/1',allowlistDigest:await R.allowlistDigest(list)});
// The dry run proposes, the apply executes exactly that list with a GO that names it.
const plan=async(env,options={})=>{const report=await R.dryRunDimensionRetirement(env,{coverage,...options});return report;};
const apply=async(env,list,options={})=>R.applyDimensionRetirement(env,{runId:'run-1',allowlist:list,go:await goOf(list),checkpoint:memory(),coverage,now:clock,...options});
// A D1 binding that COMMITS the batch containing a retirement delete and then loses the reply.
const lossy=file=>{const db=d1Standin(file),real=db.batch.bind(db);let armed=true;db.batch=async statements=>{const result=await real(statements);if(armed&&statements.some(item=>/DELETE FROM film_dimension/.test(item.text))){armed=false;throw new Error('D1_ERROR: network connection lost');}return result;};return db;};

// ---- 1. The dry run is read only, proposes only stale copies in the three retirable dimensions and reports everything it retains ----
{
 const file=database();
 copyFilm(file,'film:a','1');
 copyFilm(file,'film:b','2',{metadata:{status:'reviewed'},fingerprint:{status:'reviewed'},prediction:{authority:'owner'}});
 copyFilm(file,'film:c','3',{metadata:{provenance_json:JSON.stringify({titleSource:{source:'tmdb'}})},fingerprint:{provenance_json:'{bad'}});
 copyFilm(file,'film:d','4',{metadata:{authority:'owner'},prediction:{status:'weird'}});
 exec(file,insert('film',{id:'film:e',contract_version:1,canonical_identity:null,original_title:null,updated_at:T})+dim('film:e','fingerprint')+dim('film:e','metadata')); // no identity claim and no metadata row: nothing can be proved
 const env={DB:d1Standin(file)};
 const before=everything(file);
 const report=await plan(env,{limit:50});
 assert.equal(everything(file),before,'a dry run writes no row and bumps no revision');
 assert.deepEqual(receipts(file),[],'a dry run opens no receipt');
 assert.deepEqual(report.eligible.map(item=>item.id+'/'+item.dimension),['film:a/fingerprint','film:a/metadata','film:a/prediction','film:c/prediction','film:d/fingerprint'],'only plain stale copies of Films whose identity passes: the other rows of Films b, c, d and e are retained');
 assert.ok(report.eligible.every(item=>item.revision===0&&/^[0-9a-f]{64}$/.test(item.rowDigest)));
 assert.deepEqual([report.examined,report.hasMore,report.wouldWrite,report.allowlist.length],[5,false,3,5]);
 assert.equal(report.allowlistDigest,await R.allowlistDigest(report.allowlist));
 const retained=report.retained.byReason;
 assert.equal(retained['metadata:class_control'],2,'a reviewed row and an owner-authority row are the ADR 0214 lock');
 assert.equal(retained['fingerprint:class_unknown_legacy'],2,'a reviewed row and an unreadable provenance are never candidates');
 assert.equal(retained['prediction:class_unknown_legacy'],2,'an owner authority and an unknown status are unknown legacy');
 assert.deepEqual([retained['fingerprint:proof_incomplete'],retained['metadata:proof_incomplete']],[1,1],'a Film with no identity claim has no stable alias and no metadata row: its plain copies are retained, unproved');
 assert.equal(retained['metadata:class_unknown_legacy'],1,'a titleSource outside identity is unknown legacy');
 assert.equal(retained['identity:dimension_not_retirable'],4,'identity rows are never retired here');
 assert.equal(retained['localization:dimension_not_retirable'],4,'localization rows are never retired here');
 // Without a coverage supplier no fingerprint or prediction is ever proved: only metadata can be a candidate.
 const blind=await R.dryRunDimensionRetirement(env,{limit:50});
 assert.deepEqual(blind.eligible.map(item=>item.id+'/'+item.dimension),['film:a/metadata']);
 assert.equal(blind.retained.byReason['fingerprint:proof_incomplete'],3,'Films a, d and e: nothing is proved without candidate coverage');
 // pages
 const first=await plan(env,{limit:2});
 assert.deepEqual([first.examined,first.hasMore,first.cursor],[2,true,'film:b']);
 await assert.rejects(()=>R.dryRunDimensionRetirement(env,{limit:51}),code('film_person_invalid'));
 await assert.rejects(()=>R.dryRunDimensionRetirement(env,{writeCap:26}),code('film_person_invalid'));
 await assert.rejects(()=>R.dryRunDimensionRetirement(env,{after:'x'}),code('film_person_invalid'));
}

// ---- 2. The parity reader classifies exactly the requested Films (the ids option) the same way a page does ----
{
 const file=database();
 copyFilm(file,'film:a','1');copyFilm(file,'film:b','2');copyFilm(file,'film:c','3');
 const env={DB:d1Standin(file)};
 const page=await readDimensionParity(env,{limit:10,coverage});
 const some=await readDimensionParity(env,{ids:['film:c','film:a','film:missing'],limit:10,coverage});
 assert.deepEqual([some.films,some.next],[2,null]);
 const key=item=>item.film_id+'/'+item.dimension+'/'+item.class+'/'+item.proof;
 assert.deepEqual(some.classified.map(key).sort(),page.classified.filter(item=>item.film_id!=='film:b').map(key).sort());
 await assert.rejects(()=>readDimensionParity(env,{ids:['film:a','film:a'],limit:10}),code('parity_invalid'));
 await assert.rejects(()=>readDimensionParity(env,{ids:['person:x'],limit:10}),code('parity_invalid'));
 await assert.rejects(()=>readDimensionParity(env,{ids:['film:a','film:b'],limit:1}),code('parity_invalid'));
}

// ---- 3. Apply: the exact allowlist and its GO, a durable pre-image BEFORE the delete, one fenced receipted batch, the post-delete revision recorded ----
{
 const file=database();
 copyFilm(file,'film:a','1');copyFilm(file,'film:b','2');
 exec(file,insert('prediction_fingerprint',{film_id:'tmdb_1',fingerprint_hash:'h1',schema_version:1,prompt_version:1,generated_at:T,invalidated_at:null,r2_key:'fp/1',content_sha256:'a'.repeat(64),features_json:'{}'}));
 const env={DB:d1Standin(file)};
 const report=await plan(env);
 const list=report.allowlist.filter(item=>item.id==='film:a');
 // validation comes first: nothing is read for writing, nothing changes
 const untouched=everything(file);
 await assert.rejects(async()=>R.applyDimensionRetirement(env,{runId:'r',allowlist:list,go:await goOf(list),now:clock,coverage}),code('film_person_invalid'),'an apply without a checkpoint port fails closed');
 await assert.rejects(async()=>R.applyDimensionRetirement(env,{runId:'r',allowlist:list,go:await goOf(list),checkpoint:{record:async()=>{}},now:clock}),code('film_person_invalid'));
 await assert.rejects(()=>R.applyDimensionRetirement(env,{runId:'r',allowlist:list,checkpoint:memory(),now:clock}),code('film_person_invalid'),'no GO');
 await assert.rejects(()=>R.applyDimensionRetirement(env,{runId:'r',allowlist:list,go:{reference:'http://insecure',allowlistDigest:'0'.repeat(64)},checkpoint:memory(),now:clock}),code('film_person_invalid'));
 await assert.rejects(()=>R.applyDimensionRetirement(env,{runId:'r',allowlist:list,go:{reference:'https://example.test/go',allowlistDigest:'0'.repeat(64)},checkpoint:memory(),now:clock}),code(R.RETIRE_GO_MISMATCH),'a GO for another allowlist authorizes nothing');
 await assert.rejects(async()=>R.applyDimensionRetirement(env,{runId:'r',allowlist:report.allowlist,go:await goOf(list),checkpoint:memory(),now:clock}),code(R.RETIRE_GO_MISMATCH),'a longer allowlist than the GO names');
 await assert.rejects(async()=>R.applyDimensionRetirement(env,{runId:' ',allowlist:list,go:await goOf(list),checkpoint:memory(),now:clock}),code('film_person_invalid'));
 assert.equal(everything(file),untouched);
 assert.deepEqual(receipts(file),[]);
 const port=memory(),order=[];
 const spy={record:async intent=>{order.push(['record',revision(file,'film:a'),names(file,'film:a').length]);await port.record(intent);},settle:async(intent,result)=>{order.push(['settle',revision(file,'film:a'),names(file,'film:a').length]);await port.settle(intent,result);}};
 const run=await R.applyDimensionRetirement(env,{runId:'run-1',allowlist:list,go:await goOf(list),checkpoint:spy,coverage,now:clock});
 assert.deepEqual([run.written.length,run.uncertain.length,run.moved.length,run.stopped],[1,0,0,null]);
 assert.deepEqual(order,[['record',0,5],['settle',1,2]],'the pre-image is durable before the rows go and settled after');
 const token=run.written[0];
 assert.deepEqual([token.id,token.plannedRevision,token.postRevision,token.rows.map(row=>row.dimension)],['film:a',0,1,['fingerprint','metadata','prediction']]);
 assert.deepEqual(token.rows.map(row=>row.preImage.status),['current','fresh','current'],'the pre-image is the stored row, every column');
 assert.equal(port.log.records[0].requestId,token.requestId,'the recorded intent is the returned token');
 assert.deepEqual(names(file,'film:a'),['identity','localization'],'only the three listed copies are gone; identity and localization stay');
 assert.deepEqual(names(file,'film:b'),['fingerprint','identity','localization','metadata','prediction'],'an unlisted Film is untouched');
 assert.equal(one(file,"SELECT count(*) FROM film_metadata WHERE film_id='film:a'"),1,'the metadata VALUES row (film_metadata) is not a dimension row and stays');
 assert.equal(one(file,"SELECT count(*) FROM prediction_fingerprint"),1,'the prediction domain is never touched');
 assert.equal(revision(file,'film:a'),1);
 const stored=receipts(file);
 assert.deepEqual(stored.map(r=>[r.operation,r.origin,r.target_id,r.state,r.applied_revision,r.planned_revision]),[['film_dimension_retire','dimension_retirement','film:a','applied',1,0]]);
 assert.equal(stored[0].request_id,token.requestId);
 // replaying the same allowlist finds nothing: the rows are gone, never retried blind
 const again=await apply(env,list,{runId:'run-2'});
 assert.deepEqual([again.written.length,again.moved.map(item=>item.reason),receipts(file).length,revision(file,'film:a')],[0,['row_absent','row_absent','row_absent'],1,1]);
 assert.ok(OPERATION_KINDS.includes('film_dimension_retire'));
}

// ---- 4. An unlisted row is never deleted; a listed row that moved since the dry run is skipped and reported ----
{
 const file=database();
 copyFilm(file,'film:a','1');
 const env={DB:d1Standin(file)};
 const report=await plan(env);
 const onlyFingerprint=report.allowlist.filter(item=>item.dimension==='fingerprint');
 const run=await apply(env,onlyFingerprint);
 assert.equal(run.written.length,1);
 assert.deepEqual(names(file,'film:a'),['identity','localization','metadata','prediction'],'only the listed row is deleted');
 // the stored bytes changed after the dry run: skipped, never deleted
 const file2=database();
 copyFilm(file2,'film:a','1');
 const env2={DB:d1Standin(file2)};
 const list2=(await plan(env2)).allowlist;
 exec(file2,"UPDATE film_dimension SET last_error='x',attempts=3 WHERE film_id='film:a' AND dimension='prediction'");
 const run2=await apply(env2,list2);
 assert.deepEqual([run2.written[0].rows.map(row=>row.dimension),run2.moved.map(item=>[item.dimension,item.reason])],[['fingerprint','metadata'],[['prediction','row_digest']]]);
 assert.deepEqual(names(file2,'film:a'),['identity','localization','prediction']);
 // the row became a lock after the dry run: classified control now, never deleted (no revision bump was needed for it to change)
 const file3=database();
 copyFilm(file3,'film:a','1');
 const env3={DB:d1Standin(file3)};
 const list3=(await plan(env3)).allowlist;
 exec(file3,"UPDATE film_dimension SET status='reviewed' WHERE film_id='film:a' AND dimension='metadata';UPDATE film_dimension SET authority='owner' WHERE film_id='film:a' AND dimension='prediction'");
 const run3=await apply(env3,list3);
 assert.deepEqual(run3.moved.map(item=>item.dimension).sort(),['metadata','prediction']);
 assert.deepEqual(names(file3,'film:a'),['identity','localization','metadata','prediction'],'a lock or an owner row is never deleted, and the fingerprint copy still is');
 // evidence that made the copy provable disappeared: no longer complete
 const file4=database();
 copyFilm(file4,'film:a','1');
 const env4={DB:d1Standin(file4)};
 const list4=(await plan(env4)).allowlist;
 const incomplete=await apply(env4,list4,{coverage:()=>({status:'incomplete',reason:'seed_absent_unproved'})});
 assert.deepEqual(incomplete.moved.map(item=>[item.dimension,item.reason]),[['fingerprint','proof_incomplete'],['prediction','proof_incomplete']]);
 assert.deepEqual(incomplete.written[0].rows.map(row=>row.dimension),['metadata']);
}

// ---- 5. Concurrent changes: the revision CAS and the exact pre-image refuse the whole Film; nothing is retried blind ----
{
 // a canonical writer bumps the revision between the read and the batch
 const file=database();
 copyFilm(file,'film:a','1');
 const env={DB:d1Standin(file,{onBatch:async statements=>{if(statements.some(item=>/DELETE FROM film_dimension/.test(item.text)))exec(file,"INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film','film:a',1,'"+T+"') ON CONFLICT(kind,id) DO UPDATE SET revision=revision+1")}})};
 const list=(await plan({DB:d1Standin(file)})).allowlist;
 const port=memory();
 const run=await R.applyDimensionRetirement(env,{runId:'cas',allowlist:list,go:await goOf(list),checkpoint:port,coverage,now:clock});
 assert.deepEqual([run.written.length,run.uncertain.length,run.stopped,run.moved.length],[0,0,null,3]);
 assert.equal(run.moved[0].code,'film_person_revision_conflict');
 assert.deepEqual(names(file,'film:a'),['fingerprint','identity','localization','metadata','prediction'],'the batch rolled back whole');
 assert.equal(port.log.settles[0][1].state,'not_applied','the definite refusal is settled in the checkpoint');
 assert.deepEqual(receipts(file).map(r=>r.state),['failed'],'the receipt is failed, not applied (and is never replayed by this module)');
 // a row changes WITHOUT a revision bump (the pre-image assertion inside the batch catches it)
 const file2=database();
 copyFilm(file2,'film:a','1');
 const env2={DB:d1Standin(file2,{onBatch:async statements=>{if(statements.some(item=>/DELETE FROM film_dimension/.test(item.text)))exec(file2,"UPDATE film_dimension SET status='reviewed' WHERE film_id='film:a' AND dimension='metadata'")}})};
 const list2=(await plan({DB:d1Standin(file2)})).allowlist;
 const run2=await R.applyDimensionRetirement(env2,{runId:'pre',allowlist:list2,go:await goOf(list2),checkpoint:memory(),coverage,now:clock});
 assert.deepEqual([run2.written.length,run2.moved[0].code],[0,R.RETIRE_ROW_CHANGED]);
 assert.deepEqual(names(file2,'film:a'),['fingerprint','identity','localization','metadata','prediction'],'a lock that appears inside the window is never deleted');
 // a held marker refuses before any read for writing
 const held=database({held:true});
 copyFilm(held,'film:a','1');
 const heldEnv={DB:d1Standin(held)};
 const listHeld=[{id:'film:a',dimension:'metadata',rowDigest:'a'.repeat(64)}];
 await assert.rejects(async()=>R.applyDimensionRetirement(heldEnv,{runId:'h',allowlist:listHeld,go:await goOf(listHeld),checkpoint:memory(),now:clock}),code('film_person_held'));
 assert.deepEqual(receipts(held),[]);
}

// ---- 6. The checkpoint is fail closed: a refused record writes nothing, a failed settlement stops the pass ----
{
 const file=database();
 copyFilm(file,'film:a','1');copyFilm(file,'film:b','2');
 const env={DB:d1Standin(file)};
 const list=(await plan(env)).allowlist;
 const before=everything(file);
 const refused=await apply(env,list,{checkpoint:memory({failRecord:true})});
 assert.deepEqual([refused.written.length,refused.stopped,refused.error.id],[0,R.RETIRE_CHECKPOINT_FAILED,'film:a']);
 assert.equal(everything(file),before,'no pre-image, no delete');
 assert.deepEqual(receipts(file),[]);
 const unsettled=await apply(env,list,{checkpoint:memory({failSettle:true})});
 assert.deepEqual([unsettled.written.length,unsettled.stopped,unsettled.error.id],[1,'retire_checkpoint_settle_failed','film:a'],'a delete that could not be settled is reported and the pass stops');
 assert.deepEqual(names(file,'film:b').length,5,'the next Film is not touched after a failed settlement');
}

// ---- 7. The write cap bounds a run and reports what it left ----
{
 const file=database();
 for(const [id,tmdb] of [['film:a','1'],['film:b','2'],['film:c','3']])copyFilm(file,id,tmdb);
 const env={DB:d1Standin(file)};
 const list=(await plan(env)).allowlist;
 assert.equal(list.length,9);
 const run=await apply(env,list,{writeCap:2});
 assert.deepEqual([run.written.length,run.stopped,run.skipped.map(item=>item.id)],[2,'write_cap',['film:c','film:c','film:c']]);
 assert.deepEqual([names(file,'film:c').length,names(file,'film:a').length],[5,2]);
 assert.deepEqual((await plan(env,{writeCap:1})).wouldWrite,1);
}

// ---- 8. A reply lost after the commit is recovered from the recorded intent, never from a replan ----
{
 const file=database();
 copyFilm(file,'film:a','1');
 const env={DB:lossy(file)};
 const list=(await plan({DB:d1Standin(file)})).allowlist;
 const port=memory();
 const run=await R.applyDimensionRetirement(env,{runId:'lost',allowlist:list,go:await goOf(list),checkpoint:port,coverage,now:clock});
 assert.deepEqual([run.written.length,run.uncertain.length,run.stopped],[0,1,run.error.code]);
 const intent=run.uncertain[0];
 assert.equal(port.log.settles[0][1].state,'unknown');
 assert.deepEqual(names(file,'film:a'),['identity','localization'],'the delete did commit');
 const clean={DB:d1Standin(file)};
 const found=await R.recoverDimensionRetirement(clean,{intent});
 assert.deepEqual([found.state,found.atPostRevision],['applied',true]);
 // a never-written intent is not_applied and resumable under the SAME request id
 const file2=database();
 copyFilm(file2,'film:a','1');
 const env2={DB:d1Standin(file2)};
 const list2=(await plan(env2)).allowlist;
 const failing=await apply(env2,list2,{checkpoint:memory({failRecord:true})});
 assert.equal(failing.written.length,0);
 const blocked=await R.applyDimensionRetirement({DB:d1Standin(file2,{onBatch:async()=>{throw new Error('D1_ERROR: network connection lost');}})},{runId:'rb',allowlist:list2,go:await goOf(list2),checkpoint:memory(),coverage,now:clock});
 const ghost=blocked.uncertain[0];
 assert.ok(ghost,'a batch that never ran is unknown to the caller, and kept with its intent');
 const state=await R.recoverDimensionRetirement(env2,{intent:ghost});
 assert.equal(state.state,'not_applied');
 const resumed=await R.resumeDimensionRetirement(env2,{intent:ghost,checkpoint:memory(),now:clock});
 assert.equal(resumed.state,'applied');
 assert.deepEqual(names(file2,'film:a'),['identity','localization']);
 assert.equal((await R.recoverDimensionRetirement(env2,{intent:ghost})).state,'applied');
 await assert.rejects(()=>R.resumeDimensionRetirement(env2,{intent:ghost,now:clock}),code('film_person_invalid'),'a resume needs the durable checkpoint too');
 await assert.rejects(()=>R.resumeDimensionRetirement(env2,{intent:ghost,checkpoint:memory({failRecord:true}),now:clock}),code(R.RETIRE_CHECKPOINT_FAILED));
 assert.equal((await R.recoverDimensionRetirement(env2,{intent:{...ghost,digest:'0'.repeat(64)}}).catch(error=>({state:error.code}))).state,'film_person_invalid');
}

// ---- 9. Restore: only an empty slot, only at the exact recorded post-delete revision; anything else is reported and the newer state kept ----
{
 const file=database();
 copyFilm(file,'film:a','1');
 const env={DB:d1Standin(file)};
 const list=(await plan(env)).allowlist;
 const token=(await apply(env,list)).written[0];
 const before=await R.restoreDimensionRetirement(env,{runId:'undo-0',token,now:clock});
 assert.deepEqual([before.state,before.rows.map(row=>row.status)],['applied',['restorable','restorable','restorable']]);
 assert.deepEqual(names(file,'film:a'),['fingerprint','identity','localization','metadata','prediction'],'the pre-image rows are back');
 assert.deepEqual(rows(file,"SELECT status,updated_at,attempts FROM film_dimension WHERE film_id='film:a' AND dimension='metadata'"),[{status:'fresh',updated_at:T,attempts:0}],'byte-identical to the pre-image');
 assert.equal(revision(file,'film:a'),2,'a restore is a write: it bumps the revision');
 const second=await R.restoreDimensionRetirement(env,{runId:'undo-1',token,now:clock});
 assert.deepEqual([second.state,second.reason,second.rows.map(row=>row.status)],['refused','film_moved',['retained_newer_state','retained_newer_state','retained_newer_state']],'a second restore of the same token is refused');
 // another writer moved the Film after the retirement
 const file2=database();
 copyFilm(file2,'film:a','1');
 const env2={DB:d1Standin(file2)};
 const token2=(await apply(env2,(await plan(env2)).allowlist)).written[0];
 exec(file2,"UPDATE canonical_revision SET revision=revision+1 WHERE kind='film' AND id='film:a'");
 const newer=everything(file2);
 const refused=await R.restoreDimensionRetirement(env2,{runId:'undo-2',token:token2,now:clock});
 assert.deepEqual([refused.state,refused.reason],['refused','film_moved']);
 assert.equal(everything(file2),newer,'the newer state is retained');
 assert.equal(receipts(file2).length,1,'a refused restore reserves no receipt');
 // a slot refilled at the same revision: that row is left, the others come back
 const file3=database();
 copyFilm(file3,'film:a','1');
 const env3={DB:d1Standin(file3)};
 const token3=(await apply(env3,(await plan(env3)).allowlist)).written[0];
 exec(file3,dim('film:a','fingerprint',{status:'generating'}));
 const partial=await R.restoreDimensionRetirement(env3,{runId:'undo-3',token:token3,now:clock});
 assert.deepEqual([partial.state,partial.rows.map(row=>row.dimension+':'+row.status)],['applied',['fingerprint:slot_occupied','metadata:restorable','prediction:restorable']]);
 assert.deepEqual(rows(file3,"SELECT dimension,status FROM film_dimension WHERE film_id='film:a' AND dimension IN ('fingerprint','metadata','prediction') ORDER BY dimension"),[{dimension:'fingerprint',status:'generating'},{dimension:'metadata',status:'fresh'},{dimension:'prediction',status:'current'}],'the occupied slot keeps the newer row');
 // every slot occupied at the same revision: nothing to restore
 const file4=database();
 copyFilm(file4,'film:a','1');
 const env4={DB:d1Standin(file4)};
 const token4=(await apply(env4,(await plan(env4)).allowlist)).written[0];
 exec(file4,dim('film:a','fingerprint')+dim('film:a','metadata')+dim('film:a','prediction'));
 assert.equal((await R.restoreDimensionRetirement(env4,{runId:'undo-4',token:token4,now:clock})).state,'nothing_to_restore');
 // a slot refilled inside the window between the plan and the batch refuses the batch whole
 const file5=database();
 copyFilm(file5,'film:a','1');
 const env5={DB:d1Standin(file5)};
 const token5=(await apply(env5,(await plan(env5)).allowlist)).written[0];
 const racing={DB:d1Standin(file5,{onBatch:async statements=>{if(statements.some(item=>/INSERT INTO film_dimension/.test(item.text)))exec(file5,dim('film:a','prediction',{status:'failed'}));}})};
 await assert.rejects(()=>R.restoreDimensionRetirement(racing,{runId:'undo-5',token:token5,now:clock}),code(R.RETIRE_RESTORE_MOVED));
 assert.deepEqual(dimRows(file5,'film:a').filter(row=>row.dimension==='prediction'),[{dimension:'prediction',status:'failed',authority:null}],'the racing writer is not overwritten');
 assert.equal(names(file5,'film:a').includes('fingerprint'),false,'and nothing was half restored');
}

// ---- 10. A restore token is validated and bound to its own applied receipt before any receipt is reserved ----
{
 const file=database();
 copyFilm(file,'film:a','1');
 const env={DB:d1Standin(file)};
 const token=(await apply(env,(await plan(env)).allowlist)).written[0];
 const kept=()=>[everything(file),receipts(file).length];
 const before=kept();
 const refuse=async(bad,expected,label)=>{await assert.rejects(()=>R.restoreDimensionRetirement(env,{runId:'rs',token:bad,now:clock}),code(expected),label);assert.deepEqual(kept(),before,label+': nothing changed');};
 await refuse(null,'film_person_invalid','no token');
 await refuse({...token,rows:[]},'film_person_invalid','no rows');
 await refuse({...token,rows:token.rows.slice().reverse()},'film_person_invalid','rows out of order');
 await refuse({...token,rows:[token.rows[0],token.rows[0]]},'film_person_invalid','a repeated dimension');
 await refuse({...token,rows:[{dimension:'identity',preImage:token.rows[0].preImage}]},'film_person_invalid','a dimension that is never retired');
 await refuse({...token,rows:token.rows.map((row,index)=>index?row:{...row,preImage:{...row.preImage,value:'Подделка'}})},'film_person_invalid','a fabricated pre-image does not match the digest');
 await refuse({...token,rows:token.rows.map((row,index)=>index?row:{dimension:row.dimension,preImage:{status:'current'}})},'film_person_invalid','an incomplete pre-image');
 await refuse({...token,requestId:token.requestId+'x'},'film_person_invalid','another request identity');
 await refuse({...token,digest:'0'.repeat(64)},'film_person_invalid','another digest');
 await refuse({...token,postRevision:5},'film_person_invalid','another revision');
 await refuse({...token,id:'film:other'},'film_person_invalid','another target');
 // a well-formed intent that no applied receipt backs
 const file2=database();
 copyFilm(file2,'film:a','1');
 const env2={DB:d1Standin(file2)};
 const port=memory();
 await R.applyDimensionRetirement({DB:d1Standin(file2,{onBatch:async()=>{throw new Error('D1_ERROR: network connection lost');}})},{runId:'ghost',allowlist:(await plan(env2)).allowlist,go:await goOf((await plan(env2)).allowlist),checkpoint:port,coverage,now:clock});
 const ghost=port.log.records[0];
 const b2=[everything(file2),receipts(file2).length];
 await assert.rejects(()=>R.restoreDimensionRetirement(env2,{runId:'rs-y',token:ghost,now:clock}),code(R.RETIRE_UNBOUND),'an intent with no applied receipt');
 assert.deepEqual([everything(file2),receipts(file2).length],b2);
 // a held marker refuses the restore
 exec(file,"UPDATE film_person_authority SET cutover='held',generation=generation+1 WHERE id=1");
 await assert.rejects(()=>R.restoreDimensionRetirement(env,{runId:'rs-z',token,now:clock}),code('film_person_held'));
}

// ---- 11. The safe-delete rule: the JS twin and the SQL twin agree over the same rows, and nothing protected matches ----
{
 const file=database();
 const matrix=[];
 let index=0;
 for(const dimension of ['identity','metadata','localization','fingerprint','prediction'])
  for(const status of ['missing','fresh','current','provisional','reviewed','weird'])
   for(const authority of [null,'','owner','dictionary','importer'])
    for(const provenance of [null,'{}','{"titleSource":{"source":"tmdb"}}','{bad','[]','null'])matrix.push({id:'film:m'+(index++),dimension,status,authority,provenance});
 // one Film per row (the primary key is film+dimension); the database is a throwaway copy, only SELECT of the predicate is compared
 exec(file,'BEGIN;'+matrix.map(item=>insert('film',{id:item.id,contract_version:1,canonical_identity:null,original_title:null,updated_at:T})+dim(item.id,item.dimension,{status:item.status,authority:item.authority,provenance_json:item.provenance})).join('\n')+'COMMIT;');
 const sql=new Map(rows(file,`SELECT film_id,dimension,${R.SAFE_DELETE_SQL} AS safe FROM film_dimension`).map(row=>[row.film_id,row.safe]));
 let safe=0;
 for(const item of matrix){
  const row={film_id:item.id,dimension:item.dimension,status:item.status,authority:item.authority,provenance_json:item.provenance};
  const js=R.RETIRABLE_DIMENSIONS.includes(item.dimension)&&protectedReasons(row).length===0;
  assert.equal(sql.get(item.id)===1,js,JSON.stringify(item));
  if(js){safe++;assert.ok(!['reviewed'].includes(item.status)&&item.authority!=='owner'&&!(item.provenance||'').includes('titleSource'),'a safe row is never a lock, owner row or titleSource carrier: '+JSON.stringify(item));}
 }
 assert.ok(safe>0,'the rule does select plain copies');
}

// ---- 12. Allowlist validation, the pure rule and dormancy ----
{
 const d='a'.repeat(64);
 const bad=[[],null,[{id:'film:a',dimension:'identity',rowDigest:d}],[{id:'film:a',dimension:'localization',rowDigest:d}],[{id:'person:a',dimension:'metadata',rowDigest:d}],[{id:'film:a',dimension:'metadata',rowDigest:'x'}],[{id:'film:a',dimension:'metadata',rowDigest:d,extra:1}],[{id:'film:a',dimension:'metadata',rowDigest:d},{id:'film:a',dimension:'metadata',rowDigest:d}],Array.from({length:R.RETIRE_WRITE_MAX+1},(_,i)=>({id:'film:'+i,dimension:'metadata',rowDigest:d}))];
 for(const value of bad)assert.throws(()=>R.checkAllowlist(value),code('film_person_invalid'),JSON.stringify(value).slice(0,80));
 const sorted=R.checkAllowlist([{id:'film:b',dimension:'prediction',rowDigest:d},{id:'film:a',dimension:'metadata',rowDigest:d},{id:'film:a',dimension:'fingerprint',rowDigest:d}]);
 assert.deepEqual(sorted.map(item=>item.id+'/'+item.dimension),['film:a/fingerprint','film:a/metadata','film:b/prediction']);
 assert.equal(await R.allowlistDigest(sorted),await R.allowlistDigest([...sorted].reverse()),'the digest does not depend on the order the list was written in');
 const row={film_id:'film:a',dimension:'metadata',status:'fresh',authority:null,provenance_json:null};
 const stale={dimension:'metadata',class:'stale_copy',proof:'complete',notes:[]};
 assert.equal(R.retirementDecision(stale,row).eligible,true);
 for(const [item,reason] of [[{...stale,class:'control'},'class_control'],[{...stale,class:'agree'},'class_agree'],[{...stale,class:'unknown_legacy'},'class_unknown_legacy'],[{...stale,proof:'incomplete'},'proof_incomplete'],[{...stale,proof:'unavailable'},'proof_unavailable'],[{...stale,notes:['film_redirected']},'film_redirected'],[{...stale,dimension:'localization'},'dimension_not_retirable'],[{...stale,dimension:'identity'},'dimension_not_retirable']])assert.deepEqual(R.retirementDecision(item,row),{eligible:false,reason},reason);
 assert.deepEqual(R.retirementDecision(stale,{...row,status:'reviewed'}),{eligible:false,reason:'protected_row'},'defense in depth: the SQL rule is checked again on the stored row');
 assert.deepEqual(R.retirementDecision(stale,null),{eligible:false,reason:'row_absent'});
 // dormancy: nothing in the Worker or the build imports the module
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&full.replace(/\\/g,'/')!=='src/film-dimension-retirement.js'&&/(from|import\()\s*['"][^'"]*film-dimension-retirement/.test(fs.readFileSync(full,'utf8')))importers.push(full.replace(/\\/g,'/'));}};
 walk('src');walk('scripts');
 assert.deepEqual(importers,[],'no source, script, route, tool or Workflow imports the retirement');
 for(const f of ['package.json','wrangler.jsonc','build.mjs'])assert.ok(!fs.readFileSync(f,'utf8').includes('film-dimension-retirement'),f+' does not bundle it');
 const spec=R.filmDimensionRetireOperation();
 assert.equal(spec.operation,'film_dimension_retire');
}
console.log('film-dimension-retirement ok');
