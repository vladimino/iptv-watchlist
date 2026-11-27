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
// A Film whose identity passes the fence and whose three retirable rows are plain stale copies: proof is complete under complete, GUARDED coverage.
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
const everything=file=>JSON.stringify([rows(file,"SELECT * FROM film_dimension ORDER BY film_id,dimension"),rows(file,"SELECT * FROM film ORDER BY id"),rows(file,"SELECT * FROM film_metadata ORDER BY film_id"),rows(file,"SELECT * FROM canonical_revision ORDER BY kind,id"),rows(file,"SELECT * FROM film_external_id ORDER BY film_id,scheme,value")]);
// The supplier of candidate coverage: its verdict AND its proof as a SQL guard (here the owner-review generation stands in for the ratings-evidence generation the real supplier asserts).
const GUARD={sql:'(SELECT generation FROM owner_review_authority WHERE id=1)=?',params:[1]};
const coverage=()=>({status:'complete',guards:[GUARD]});
const unguarded=()=>({status:'complete'});
const incomplete=()=>({status:'incomplete',reason:'seed_absent_unproved'});
const clock=()=>T3;
// The operation's durable checkpoint, in memory: record, settle and lookup of a recorded intent.
const memory=({failRecord=false,failSettle=false}={})=>{const log={records:[],settles:[]};return {log,record:async intent=>{if(failRecord)throw new Error('disk full');log.records.push(JSON.parse(JSON.stringify(intent)));},settle:async(intent,result)=>{if(failSettle)throw new Error('disk full');log.settles.push([intent,result]);},lookup:async requestId=>log.records.find(item=>item.requestId===requestId)??null};};
// The same contract on a real file, read afresh by every call: what survives a restart.
const durable=file=>{const entries=()=>fs.existsSync(file)?fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];return {entries,record:async intent=>{fs.appendFileSync(file,JSON.stringify({kind:'record',intent})+'\n');},settle:async(intent,result)=>{fs.appendFileSync(file,JSON.stringify({kind:'settle',requestId:intent.requestId,result})+'\n');},lookup:async requestId=>entries().find(item=>item.kind==='record'&&item.intent.requestId===requestId)?.intent??null};};
const goOf=async list=>({reference:'https://example.test/owner-go/1',allowlistDigest:await R.allowlistDigest(list)});
const plan=async(env,options={})=>R.dryRunDimensionRetirement(env,{coverage,...options});
const apply=async(env,list,options={})=>R.applyDimensionRetirement(env,{runId:'run-1',allowlist:list,go:await goOf(list),checkpoint:memory(),coverage,now:clock,...options});
const keyOf=item=>item.id+'/'+item.dimension;
// Every allowlist entry is in exactly one bucket of a pass: nothing is silently dropped.
const accounted=(run,list)=>{
 const keys=[...run.written.flatMap(intent=>intent.rows.map(row=>intent.id+'/'+row.dimension)),...run.uncertain.flatMap(intent=>intent.rows.map(row=>intent.id+'/'+row.dimension)),...run.moved.map(keyOf),...run.remaining.map(keyOf),...run.beforeCursor.map(keyOf)];
 assert.deepEqual(keys.sort(),list.map(keyOf).sort(),'every allowlist entry is accounted for exactly once');
};
// A D1 binding that COMMITS the batch containing a retirement delete and then loses the reply.
const lossy=file=>{const db=d1Standin(file),real=db.batch.bind(db);let armed=true;db.batch=async statements=>{const result=await real(statements);if(armed&&statements.some(item=>/DELETE FROM film_dimension/.test(item.text))){armed=false;throw new Error('D1_ERROR: network connection lost');}return result;};return db;};
// A binding whose every batch fails before anything lands (the Worker never learns the outcome, and nothing was written).
const dead=file=>d1Standin(file,{onBatch:async()=>{throw new Error('D1_ERROR: network connection lost');}});
// A binding that changes the database right before the batch that deletes (after classification and after the checkpoint).
const racing=(file,sql)=>d1Standin(file,{onBatch:async statements=>{if(statements.some(item=>/DELETE FROM film_dimension/.test(item.text)))exec(file,sql);}});
const COLS=['status','source','source_version','provenance_json','value','authority','last_error','failure_reason','retry_at','attempts','next_action','updated_at'];
const preImageOf=(file,id,dimension)=>rows(file,`SELECT ${COLS.join(',')} FROM film_dimension WHERE film_id=${q(id)} AND dimension=${q(dimension)}`)[0];
// An intent anybody can compute: valid shape, digest and request id that recompute, issued by nobody.
const fabricate=async(file,id,dims,{approval,proof,at=T3,plannedRevision=0,runId='fab'})=>{
 const intentRows=dims.map(dimension=>({dimension,preImage:preImageOf(file,id,dimension)}));
 const base={id,rows:intentRows,at,plannedRevision,approval,proof};
 const digest=await R.retireDigest(base);
 return {version:1,id,runId,requestId:await R.retireRequestId({runId,id,digest}),digest,at,plannedRevision,postRevision:plannedRevision+1,approval,proof,rows:intentRows};
};

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
 assert.deepEqual(report.eligible.map(keyOf),['film:a/fingerprint','film:a/metadata','film:a/prediction','film:c/prediction','film:d/fingerprint'],'only plain stale copies of Films whose identity passes: the other rows of Films b, c, d and e are retained');
 assert.ok(report.eligible.every(item=>item.revision===0&&/^[0-9a-f]{64}$/.test(item.rowDigest)));
 assert.deepEqual([report.examined,report.hasMore,report.films,report.allowlist.length],[5,false,3,5],'the page is the scope: no Film ceiling cuts the proposal');
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
 assert.deepEqual(blind.eligible.map(keyOf),['film:a/metadata']);
 assert.equal(blind.retained.byReason['fingerprint:proof_incomplete'],3,'Films a, d and e: nothing is proved without candidate coverage');
 // A verdict without its proof is not enough: the supplier's guards are what the deleting batch asserts again.
 const bare=await R.dryRunDimensionRetirement(env,{limit:50,coverage:unguarded});
 assert.deepEqual(bare.eligible.map(keyOf),['film:a/metadata'],'complete coverage with no guards fences nothing: fingerprint and prediction are retained');
 assert.deepEqual([bare.retained.byReason['fingerprint:coverage_unguarded'],bare.retained.byReason['prediction:coverage_unguarded']],[2,2]);
 // pages: the parity reader's own page, nothing narrower
 const first=await plan(env,{limit:2});
 assert.deepEqual([first.examined,first.hasMore,first.cursor],[2,true,'film:b']);
 const second=await plan(env,{limit:2,after:first.cursor});
 assert.deepEqual([second.examined,second.cursor],[2,'film:d']);
 await assert.rejects(()=>R.dryRunDimensionRetirement(env,{limit:201}),code('film_person_invalid'),'the one ceiling is the parity reader page');
 await assert.rejects(()=>R.dryRunDimensionRetirement(env,{limit:0}),code('film_person_invalid'));
 await assert.rejects(()=>R.dryRunDimensionRetirement(env,{after:'x'}),code('film_person_invalid'));
 assert.equal((await plan(env,{limit:200})).examined,5);
}

// ---- 2. The parity reader classifies exactly the requested Films (the ids option) and returns the generations it read under ----
{
 const file=database();
 copyFilm(file,'film:a','1');copyFilm(file,'film:b','2');copyFilm(file,'film:c','3');
 const env={DB:d1Standin(file)};
 const page=await readDimensionParity(env,{limit:10,coverage});
 const some=await readDimensionParity(env,{ids:['film:c','film:a','film:missing'],limit:10,coverage});
 assert.deepEqual([some.films,some.next],[2,null]);
 assert.deepEqual(some.pins,{filmPerson:2,prediction:1,ownerReview:1},'the proof tokens of the page, not labels');
 const key=item=>item.film_id+'/'+item.dimension+'/'+item.class+'/'+item.proof;
 assert.deepEqual(some.classified.map(key).sort(),page.classified.filter(item=>item.film_id!=='film:b').map(key).sort());
 await assert.rejects(()=>readDimensionParity(env,{ids:['film:a','film:a'],limit:10}),code('parity_invalid'));
 await assert.rejects(()=>readDimensionParity(env,{ids:['person:x'],limit:10}),code('parity_invalid'));
 await assert.rejects(()=>readDimensionParity(env,{ids:['film:a','film:b'],limit:1}),code('parity_invalid'));
}

// ---- 3. Apply: the exact allowlist and its GO, a durable pre-image BEFORE the delete, one fenced receipted batch carrying its proof, the post-delete revision recorded ----
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
 await assert.rejects(async()=>R.applyDimensionRetirement(env,{runId:'r',allowlist:list,checkpoint:memory(),now:clock}),code('film_person_invalid'),'no GO');
 await assert.rejects(async()=>R.applyDimensionRetirement(env,{runId:'r',allowlist:list,go:{reference:'http://insecure',allowlistDigest:'0'.repeat(64)},checkpoint:memory(),now:clock}),code('film_person_invalid'));
 await assert.rejects(async()=>R.applyDimensionRetirement(env,{runId:'r',allowlist:list,go:{reference:'https://example.test/go',allowlistDigest:'0'.repeat(64)},checkpoint:memory(),now:clock}),code(R.RETIRE_GO_MISMATCH),'a GO for another allowlist authorizes nothing');
 await assert.rejects(async()=>R.applyDimensionRetirement(env,{runId:'r',allowlist:report.allowlist,go:await goOf(list),checkpoint:memory(),now:clock}),code(R.RETIRE_GO_MISMATCH),'a longer allowlist than the GO names');
 await assert.rejects(async()=>R.applyDimensionRetirement(env,{runId:' ',allowlist:list,go:await goOf(list),checkpoint:memory(),now:clock}),code('film_person_invalid'));
 await assert.rejects(async()=>R.applyDimensionRetirement(env,{runId:'r',allowlist:list,go:await goOf(list),checkpoint:memory(),maxFilms:0,now:clock}),code('film_person_invalid'));
 await assert.rejects(async()=>R.applyDimensionRetirement(env,{runId:'r',allowlist:list,go:await goOf(list),checkpoint:memory(),queryBudget:1001,now:clock}),code('film_person_invalid'),'the budget can only lower the provider limit');
 assert.equal(everything(file),untouched);
 assert.deepEqual(receipts(file),[]);
 const port=memory(),order=[];
 const spy={...port,record:async intent=>{order.push(['record',revision(file,'film:a'),names(file,'film:a').length]);await port.record(intent);},settle:async(intent,result)=>{order.push(['settle',revision(file,'film:a'),names(file,'film:a').length]);await port.settle(intent,result);}};
 const run=await R.applyDimensionRetirement(env,{runId:'run-1',allowlist:list,go:await goOf(list),checkpoint:spy,coverage,now:clock});
 assert.deepEqual([run.written.length,run.uncertain.length,run.moved.length,run.stopped],[1,0,0,null]);
 assert.deepEqual(order,[['record',0,5],['settle',1,2]],'the pre-image is durable before the rows go and settled after');
 const token=run.written[0];
 assert.deepEqual([token.id,token.plannedRevision,token.postRevision,token.rows.map(row=>row.dimension)],['film:a',0,1,['fingerprint','metadata','prediction']]);
 assert.deepEqual(token.rows.map(row=>row.preImage.status),['current','fresh','current'],'the pre-image is the stored row, every column');
 assert.deepEqual(token.approval,await goOf(list),'the intent carries the approval it was issued under');
 assert.deepEqual([token.proof.filmPerson,token.proof.prediction,token.proof.guards,token.proof.retired,typeof token.proof.claims,typeof token.proof.metadata],[2,1,[GUARD],'[]','string','string'],'and the proof tokens it stands on');
 assert.equal(token.proof.claims,'[["tmdb","1",1,0]]','a printable JSON token of the Film own claims');
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
 accounted(again,list);
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
 accounted(run2,list2);
 // the row became a lock after the dry run: classified control now, never deleted (no revision bump was needed for it to change)
 const file3=database();
 copyFilm(file3,'film:a','1');
 const env3={DB:d1Standin(file3)};
 const list3=(await plan(env3)).allowlist;
 exec(file3,"UPDATE film_dimension SET status='reviewed' WHERE film_id='film:a' AND dimension='metadata';UPDATE film_dimension SET authority='owner' WHERE film_id='film:a' AND dimension='prediction'");
 const run3=await apply(env3,list3);
 assert.deepEqual(run3.moved.map(item=>item.dimension).sort(),['metadata','prediction']);
 assert.deepEqual(names(file3,'film:a'),['identity','localization','metadata','prediction'],'a lock or an owner row is never deleted, and the fingerprint copy still is');
 // evidence that made the copy provable disappeared: no longer complete, or no longer guarded
 const file4=database();
 copyFilm(file4,'film:a','1');
 const env4={DB:d1Standin(file4)};
 const list4=(await plan(env4)).allowlist;
 const lost=await apply(env4,list4,{coverage:incomplete});
 assert.deepEqual(lost.moved.map(item=>[item.dimension,item.reason]),[['fingerprint','proof_incomplete'],['prediction','proof_incomplete']]);
 assert.deepEqual(lost.written[0].rows.map(row=>row.dimension),['metadata']);
 const file5=database();
 copyFilm(file5,'film:a','1');
 const env5={DB:d1Standin(file5)};
 const list5=(await plan(env5)).allowlist;
 const bare=await apply(env5,list5,{coverage:unguarded});
 assert.deepEqual(bare.moved.map(item=>[item.dimension,item.reason]),[['fingerprint','coverage_unguarded'],['prediction','coverage_unguarded']],'a supplier that stopped offering its proof fences nothing, so nothing is deleted on its word');
}

// ---- 5. Concurrent changes: the revision CAS and the exact pre-image refuse the whole Film; nothing is retried blind ----
{
 // a canonical writer bumps the revision between the read and the batch
 const file=database();
 copyFilm(file,'film:a','1');
 const env=racing(file,"INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film','film:a',1,'"+T+"') ON CONFLICT(kind,id) DO UPDATE SET revision=revision+1");
 const list=(await plan({DB:d1Standin(file)})).allowlist;
 const port=memory();
 const run=await R.applyDimensionRetirement(env,{runId:'cas',allowlist:list,go:await goOf(list),checkpoint:port,coverage,now:clock});
 assert.deepEqual([run.written.length,run.uncertain.length,run.stopped,run.moved.length],[0,0,null,3]);
 assert.equal(run.moved[0].code,'film_person_revision_conflict');
 assert.deepEqual(names(file,'film:a'),['fingerprint','identity','localization','metadata','prediction'],'the batch rolled back whole');
 assert.equal(port.log.settles[0][1].state,'not_applied','the definite refusal is settled in the checkpoint');
 assert.deepEqual(receipts(file).map(r=>r.state),['failed'],'the receipt is failed, not applied (and is never replayed by this module)');
 accounted(run,list);
 // a row changes WITHOUT a revision bump (the pre-image assertion inside the batch catches it)
 const file2=database();
 copyFilm(file2,'film:a','1');
 const env2=racing(file2,"UPDATE film_dimension SET status='reviewed' WHERE film_id='film:a' AND dimension='metadata'");
 const list2=(await plan({DB:d1Standin(file2)})).allowlist;
 const run2=await R.applyDimensionRetirement(env2,{runId:'pre',allowlist:list2,go:await goOf(list2),checkpoint:memory(),coverage,now:clock});
 assert.deepEqual([run2.written.length,run2.moved[0].code],[0,R.RETIRE_PROOF_MOVED]);
 assert.deepEqual(names(file2,'film:a'),['fingerprint','identity','localization','metadata','prediction'],'a lock that appears inside the window is never deleted');
 // a held marker refuses before any read for writing
 const held=database({held:true});
 copyFilm(held,'film:a','1');
 const heldEnv={DB:d1Standin(held)};
 const listHeld=[{id:'film:a',dimension:'metadata',rowDigest:'a'.repeat(64)}];
 await assert.rejects(async()=>R.applyDimensionRetirement(heldEnv,{runId:'h',allowlist:listHeld,go:await goOf(listHeld),checkpoint:memory(),now:clock}),code('film_person_held'));
 assert.deepEqual(receipts(held),[]);
}

// ---- 6. The checkpoint is fail closed: a refused record writes nothing, a failed settlement stops the pass; the rest is named, not dropped ----
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
 assert.deepEqual(refused.remaining.map(keyOf),list.map(keyOf),'every entry is still to do and says so');
 accounted(refused,list);
 const unsettled=await apply(env,list,{checkpoint:memory({failSettle:true})});
 assert.deepEqual([unsettled.written.length,unsettled.stopped,unsettled.error.id],[1,'retire_checkpoint_settle_failed','film:a'],'a delete that could not be settled is reported and the pass stops');
 assert.deepEqual(names(file,'film:b').length,5,'the next Film is not touched after a failed settlement');
 assert.deepEqual(unsettled.remaining.map(item=>item.id),['film:b','film:b','film:b']);
 accounted(unsettled,list);
}

// ---- 7. No invented ceiling: the allowlist is the scope; a pass ends early only for a named real reason and is resumable from its cursor ----
{
 const file=database();
 const ids=Array.from({length:30},(_,index)=>'film:m'+String(index+1).padStart(2,'0'));
 ids.forEach((id,index)=>copyFilm(file,id,String(index+1)));
 const env={DB:d1Standin(file)};
 const report=await plan(env,{limit:100});
 const list=report.allowlist;
 assert.deepEqual([list.length,report.films],[90,30],'a dry run proposes every eligible row of its page');
 // more Films than any former ceiling, one pass
 const whole=await apply(env,list);
 assert.deepEqual([whole.written.length,whole.stopped,whole.remaining.length,whole.moved.length],[30,null,0,0],'the approved allowlist is processed whole');
 accounted(whole,list);
 assert.ok(ids.every(id=>names(file,id).join()==='identity,localization'));
 assert.ok(whole.d1Queries<R.RETIRE_D1_QUERY_LIMIT&&whole.maxQueriesPerFilm>0);
 // the approved operation's own limit: remaining is explicit and the cursor continues under the same GO
 const file2=database();
 ids.forEach((id,index)=>copyFilm(file2,id,String(index+1)));
 const env2={DB:d1Standin(file2)};
 const list2=(await plan(env2,{limit:100})).allowlist;
 const go2=await goOf(list2);
 const first=await R.applyDimensionRetirement(env2,{runId:'part-1',allowlist:list2,go:go2,checkpoint:memory(),coverage,maxFilms:7,now:clock});
 assert.deepEqual([first.written.length,first.stopped,first.cursor,first.remaining.length],[7,'films_limit','film:m07',69]);
 accounted(first,list2);
 const rest=await R.applyDimensionRetirement(env2,{runId:'part-2',allowlist:list2,go:go2,checkpoint:memory(),coverage,after:first.cursor,now:clock});
 assert.deepEqual([rest.written.length,rest.stopped,rest.beforeCursor.length,rest.remaining.length],[23,null,21,0]);
 accounted(rest,list2);
 assert.ok(ids.every(id=>names(file2,id).join()==='identity,localization'));
 // the provider's counted D1 limit: a small budget stops before the next Film does not fit, and passes continue from the cursor until nothing remains
 const file3=database();
 ids.forEach((id,index)=>copyFilm(file3,id,String(index+1)));
 const env3={DB:d1Standin(file3)};
 const list3=(await plan(env3,{limit:100})).allowlist;
 const go3=await goOf(list3);
 let cursor='',written=0,passes=0,firstStop=null;
 for(;;){
  const pass=await R.applyDimensionRetirement(env3,{runId:'budget-'+passes,allowlist:list3,go:go3,checkpoint:memory(),coverage,after:cursor,queryBudget:170,now:clock});
  accounted(pass,list3);
  assert.ok(pass.d1Queries<=170,'the counted budget holds: '+pass.d1Queries);
  if(passes===0)firstStop=pass.stopped;
  written+=pass.written.length;passes++;cursor=pass.cursor;
  assert.ok(passes<30&&(pass.stopped===null||pass.written.length>0),'every pass progresses');
  if(pass.stopped===null)break;
  assert.equal(pass.stopped,'d1_query_budget');
 }
 assert.deepEqual([firstStop,written,passes>1],['d1_query_budget',30,true]);
 assert.ok(ids.every(id=>names(file3,id).join()==='identity,localization'));
 assert.equal(R.RETIRE_WRITE_MAX,undefined,'no hard Film ceiling is exported');
 assert.equal(R.RETIRE_ALLOWLIST_MAX,undefined);
}

// ---- 8. A reply lost after the commit is recovered from a RECORDED intent, never from a replan; recovery and resume refuse an intent nobody issued ----
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
 const found=await R.recoverDimensionRetirement(clean,{intent,checkpoint:port});
 assert.deepEqual([found.state,found.atPostRevision],['applied',true]);
 // an applied intent is never written again, and resume says so
 const resumedApplied=await R.resumeDimensionRetirement(clean,{intent,allowlist:list,go:await goOf(list),checkpoint:port,coverage,now:clock});
 assert.equal(resumedApplied.state,'applied');
 assert.equal(receipts(file).length,1);
 // a never-written intent is not_applied and resumes under the SAME request id, after its proof is proved again
 const file2=database();
 copyFilm(file2,'film:a','1');
 const env2={DB:d1Standin(file2)};
 const list2=(await plan(env2)).allowlist;
 const go2=await goOf(list2);
 const port2=memory();
 const blocked=await R.applyDimensionRetirement({DB:dead(file2)},{runId:'rb',allowlist:list2,go:go2,checkpoint:port2,coverage,now:clock});
 const ghost=blocked.uncertain[0];
 assert.ok(ghost,'a batch that never ran is unknown to the caller, and kept with its intent');
 assert.equal((await R.recoverDimensionRetirement(env2,{intent:ghost,checkpoint:port2})).state,'not_applied');
 const resumed=await R.resumeDimensionRetirement(env2,{intent:ghost,allowlist:list2,go:go2,checkpoint:port2,coverage,now:clock});
 assert.equal(resumed.state,'applied');
 assert.equal(resumed.intent.requestId,ghost.requestId,'the same request id');
 assert.equal(port2.log.records.length,1,'a resume never records a new checkpoint');
 assert.deepEqual(names(file2,'film:a'),['identity','localization']);
 assert.equal((await R.recoverDimensionRetirement(env2,{intent:ghost,checkpoint:port2})).state,'applied');
 // ports and shapes
 await assert.rejects(()=>R.recoverDimensionRetirement(env2,{intent:ghost}),code('film_person_invalid'),'recovery needs the checkpoint');
 await assert.rejects(()=>R.resumeDimensionRetirement(env2,{intent:ghost,allowlist:list2,go:go2,now:clock}),code('film_person_invalid'),'a resume needs the durable checkpoint too');
 await assert.rejects(()=>R.resumeDimensionRetirement(env2,{intent:ghost,allowlist:list2,go:go2,checkpoint:{lookup:async()=>null},now:clock}),code('film_person_invalid'),'a resume that cannot settle is refused');
 await assert.rejects(()=>R.recoverDimensionRetirement(env2,{intent:{...ghost,digest:'0'.repeat(64)},checkpoint:port2}),code('film_person_invalid'));
}

// ---- 9. Adversarial intents: a valid shape proves nothing, and a recorded intent whose proof moved is never replayed ----
{
 const file=database();
 copyFilm(file,'film:a','1');copyFilm(file,'film:b','2');
 const env={DB:d1Standin(file)};
 const list=(await plan(env)).allowlist;
 const go=await goOf(list);
 const genuine=await (async()=>{const port=memory();const run=await R.applyDimensionRetirement({DB:dead(file)},{runId:'g',allowlist:list,go,checkpoint:port,coverage,now:clock,maxFilms:1});return run.uncertain[0];})();
 assert.equal(genuine.id,'film:a');
 const before=()=>[everything(file),receipts(file).length];
 const frozen=before();
 // (a) a self-consistent intent built by anybody for a row the SQL rule would accept: nobody issued it
 const forged=await fabricate(file,'film:b',['metadata'],{approval:go,proof:{filmPerson:2,prediction:null,claims:'x',retired:'[]',metadata:'x',guards:[]}});
 assert.equal((await R.checkIntent(forged)).requestId,forged.requestId,'its shape, digest and request id are all valid');
 const empty=memory();
 await assert.rejects(()=>R.resumeDimensionRetirement(env,{intent:forged,allowlist:list,go,checkpoint:empty,coverage,now:clock}),code(R.RETIRE_INTENT_UNRECORDED),'resume does not create a checkpoint for it');
 await assert.rejects(()=>R.recoverDimensionRetirement(env,{intent:forged,checkpoint:empty}),code(R.RETIRE_INTENT_UNRECORDED));
 assert.deepEqual([empty.log.records.length,empty.log.settles.length],[0,0]);
 // a checkpoint that holds a DIFFERENT intent under that request id is no proof either
 const other=memory();other.log.records.push({...forged,at:'2026-11-25T14:00:00.000Z'});
 await assert.rejects(()=>R.resumeDimensionRetirement(env,{intent:forged,allowlist:list,go,checkpoint:other,coverage,now:clock}),code(R.RETIRE_INTENT_UNRECORDED));
 assert.deepEqual(before(),frozen);
 // (b) recorded, but not bound to the approved allowlist and GO
 const recorded=memory();recorded.log.records.push(forged);
 const otherList=list.filter(item=>item.id==='film:a');
 await assert.rejects(()=>R.resumeDimensionRetirement(env,{intent:forged,allowlist:otherList,go:{...go,allowlistDigest:go.allowlistDigest},checkpoint:recorded,coverage,now:clock}),code(R.RETIRE_GO_MISMATCH),'a GO that names another list');
 await assert.rejects(async()=>R.resumeDimensionRetirement(env,{intent:forged,allowlist:otherList,go:await goOf(otherList),checkpoint:recorded,coverage,now:clock}),code(R.RETIRE_INTENT_UNBOUND),'an approval the intent was not issued under, for a Film the allowlist does not name');
 const wrongApproval=await fabricate(file,'film:b',['metadata'],{approval:{reference:'https://example.test/other-go',allowlistDigest:go.allowlistDigest},proof:forged.proof});
 recorded.log.records.push(wrongApproval);
 await assert.rejects(()=>R.resumeDimensionRetirement(env,{intent:wrongApproval,allowlist:list,go,checkpoint:recorded,coverage,now:clock}),code(R.RETIRE_INTENT_UNBOUND),'another approval reference');
 exec(file,"UPDATE film_dimension SET attempts=9 WHERE film_id='film:b' AND dimension='metadata'");
 const staleRow=await fabricate(file,'film:b',['metadata'],{approval:go,proof:forged.proof});
 recorded.log.records.push(staleRow);
 await assert.rejects(()=>R.resumeDimensionRetirement(env,{intent:staleRow,allowlist:list,go,checkpoint:recorded,coverage,now:clock}),code(R.RETIRE_INTENT_UNBOUND),'a pre-image that is not the row the allowlist digest names');
 exec(file,"UPDATE film_dimension SET attempts=0 WHERE film_id='film:b' AND dimension='metadata'");
 assert.equal(rows(file,"SELECT attempts FROM film_dimension WHERE film_id='film:b' AND dimension='metadata'")[0].attempts,0);
 // (c) recorded AND bound, but the proof was never complete: a fabricated intent over a Film whose identity fails the fence, and one over a copy whose coverage is incomplete
 const file2=database();
 copyFilm(file2,'film:a','1');copyFilm(file2,'film:z','9');
 const env2={DB:d1Standin(file2)};
 const list2=(await plan(env2)).allowlist;
 const go2=await goOf(list2);
 exec(file2,insert('film',{id:'film:y',contract_version:1,canonical_identity:null,original_title:null,updated_at:T})+insert('film_external_id',{film_id:'film:y',scheme:'tmdb',value:'9',trusted:0,conflicting:1,provenance_json:null}));
 const failedIdentity=await fabricate(file2,'film:z',['metadata'],{approval:go2,proof:{filmPerson:2,prediction:null,claims:'[["tmdb","9",1,0]]',retired:'[]',metadata:'x',guards:[]}});
 const incompleteCoverage=await fabricate(file2,'film:a',['fingerprint'],{approval:go2,proof:{filmPerson:2,prediction:1,claims:'[["tmdb","1",1,0]]',retired:'[]',metadata:null,guards:[GUARD]}});
 const store=memory();store.log.records.push(failedIdentity,incompleteCoverage);
 const frozen2=[everything(file2),receipts(file2).length];
 const a=await R.resumeDimensionRetirement(env2,{intent:failedIdentity,allowlist:list2,go:go2,checkpoint:store,coverage,now:clock});
 assert.equal(a.state,'moved');
 assert.ok(a.reason,'the identity of the Film fails the fence: '+a.reason);
 const b=await R.resumeDimensionRetirement(env2,{intent:incompleteCoverage,allowlist:list2,go:go2,checkpoint:store,coverage:incomplete,now:clock});
 assert.deepEqual([b.state,b.reason],['moved','proof_incomplete']);
 assert.deepEqual([everything(file2),receipts(file2).length],frozen2,'nothing was deleted, nothing reserved');
 assert.deepEqual(store.log.settles.map(item=>[item[1].state,item[1].errorClass]),[['not_applied',R.RETIRE_PROOF_MOVED],['not_applied',R.RETIRE_PROOF_MOVED]],'the refusals are settled in the checkpoint');
 // (d) a previously VALID recorded intent whose proof moved after the failed attempt: each of the proof tokens, one fixture each
 const moves={
  'a competing claim of another Film':"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:rival',1,NULL,NULL,'"+T+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:rival','tmdb','1',0,0,NULL)",
  'the Film/Person marker generation':"UPDATE film_person_authority SET cutover='held',generation=generation+1 WHERE id=1;UPDATE film_person_authority SET cutover='open',generation=generation+1 WHERE id=1",
  'the prediction marker generation':"UPDATE prediction_domain_authority SET generation=generation+1 WHERE id=1",
  'the prediction marker held':"UPDATE prediction_domain_authority SET writes='held' WHERE id=1",
  'the Film own claim':"UPDATE film_external_id SET conflicting=1 WHERE film_id='film:a'",
  'the Film metadata fields':"UPDATE film_metadata SET runtime=121 WHERE film_id='film:a'",
 };
 for(const [label,sql] of Object.entries(moves)){
  const f=database();copyFilm(f,'film:a','1');
  const e={DB:d1Standin(f)};
  const l=(await plan(e)).allowlist,g=await goOf(l);
  const p=memory();
  const issued=(await R.applyDimensionRetirement({DB:dead(f)},{runId:'m',allowlist:l,go:g,checkpoint:p,coverage,now:clock})).uncertain[0];
  assert.equal((await R.recoverDimensionRetirement(e,{intent:issued,checkpoint:p})).state,'not_applied',label+': recovery alone still says not_applied');
  exec(f,sql);
  const out=await R.resumeDimensionRetirement(e,{intent:issued,allowlist:l,go:g,checkpoint:p,coverage,now:clock}).catch(error=>({state:'refused',reason:error.code}));
  assert.ok(['moved','refused'].includes(out.state),label+': '+JSON.stringify(out.state));
  assert.deepEqual(names(f,'film:a'),['fingerprint','identity','localization','metadata','prediction'],label+': nothing deleted');
  assert.equal(receipts(f).filter(item=>item.state==='applied').length,0,label+': no applied receipt');
 }
 // the supplier's own guard moves after the intent was issued: the supplier still offers it, the batch refuses it
 const f=database();copyFilm(f,'film:a','1');
 const e={DB:d1Standin(f)};
 const l=(await plan(e)).allowlist,g=await goOf(l),p=memory();
 const issued=(await R.applyDimensionRetirement({DB:dead(f)},{runId:'gm',allowlist:l,go:g,checkpoint:p,coverage,now:clock})).uncertain[0];
 exec(f,"UPDATE owner_review_authority SET generation=2 WHERE id=1");
 const guarded=await R.resumeDimensionRetirement(e,{intent:issued,allowlist:l,go:g,checkpoint:p,coverage,now:clock});
 assert.deepEqual([guarded.state,guarded.errorClass],['not_applied',R.RETIRE_PROOF_MOVED],'the batch asserts the supplier proof again, so a moved proof rolls the Film back');
 assert.deepEqual(names(f,'film:a'),['fingerprint','identity','localization','metadata','prediction']);
}

// ---- 10. Real durable checkpoint recovery: a restart reads the file, nothing else ----
{
 const file=database();
 copyFilm(file,'film:a','1');copyFilm(file,'film:b','2');
 const env={DB:d1Standin(file)};
 const list=(await plan(env)).allowlist;
 const go=await goOf(list);
 const store=path.join(root,'checkpoint-'+n+'.jsonl');
 // process 1: records the pre-image of Film a durably, the delete never reaches D1
 const first=await R.applyDimensionRetirement({DB:dead(file)},{runId:'crash',allowlist:list,go,checkpoint:durable(store),coverage,now:clock});
 assert.deepEqual([first.written.length,first.uncertain.length],[0,1]);
 assert.deepEqual(durable(store).entries().map(item=>item.kind),['record','settle'],'the file holds the intent and the unknown outcome');
 // process 2: a fresh port over the same file finds the intent by request id and nothing in memory
 const second=durable(store);
 const issued=await second.lookup(first.uncertain[0].requestId);
 assert.equal(canonicalOf(issued),canonicalOf(first.uncertain[0]),'what the file returns is the intent that was issued');
 assert.equal((await R.recoverDimensionRetirement(env,{intent:issued,checkpoint:second})).state,'not_applied');
 const resumed=await R.resumeDimensionRetirement(env,{intent:issued,allowlist:list,go,checkpoint:second,coverage,now:clock});
 assert.equal(resumed.state,'applied');
 assert.deepEqual(names(file,'film:a'),['identity','localization']);
 assert.deepEqual(names(file,'film:b'),['fingerprint','identity','localization','metadata','prediction'],'the rest of the allowlist is still to do');
 assert.deepEqual(durable(store).entries().map(item=>item.kind),['record','settle','settle'],'resume settled the existing record; it wrote no second one');
 // an entry written by anybody else is not an intent: a corrupt or foreign record is refused
 fs.appendFileSync(store,JSON.stringify({kind:'record',intent:{version:1,id:'film:b'}})+'\n');
 await assert.rejects(()=>R.recoverDimensionRetirement(env,{intent:issued,checkpoint:{lookup:async()=>({version:1,id:'film:b'})}}),code(R.RETIRE_INTENT_UNRECORDED));
 // process 3 continues the same allowlist from the cursor under the same GO
 const third=await R.applyDimensionRetirement(env,{runId:'after-crash',allowlist:list,go,checkpoint:durable(store),coverage,after:'film:a',now:clock});
 assert.deepEqual([third.written.length,third.beforeCursor.length],[1,3]);
 accounted(third,list);
}
function canonicalOf(value){return JSON.stringify(value,Object.keys(value).sort());}

// ---- 11. The proof is fenced through the delete: a change in ANY domain the classification read, after the classification and after the checkpoint, rolls the Film back ----
{
 const cases={
  'the prediction marker generation moves':"UPDATE prediction_domain_authority SET generation=generation+1 WHERE id=1",
  'the prediction domain is held':"UPDATE prediction_domain_authority SET writes='held' WHERE id=1",
  'the prediction domain leaves d1':"UPDATE prediction_domain_authority SET mode='r2' WHERE id=1",
  'the Film/Person marker generation moves':"UPDATE film_person_authority SET cutover='held',generation=generation+1 WHERE id=1;UPDATE film_person_authority SET cutover='open',generation=generation+1 WHERE id=1",
  'a competing identity claim appears on another Film':"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:rival',1,NULL,NULL,'"+T+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:rival','tmdb','1',0,0,NULL)",
  'an owner TMDB retirement decision is recorded for the movie':"INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,payload_json,recorded_at) VALUES ('d1','film:a','retire','abc','1','5','{}','{\"by\":\"owner\",\"at\":\"x\",\"source\":\"y\"}','owner_request','{}','"+T+"')",
  'the Film own identity claim changes':"UPDATE film_external_id SET conflicting=1 WHERE film_id='film:a'",
  'the Film gains another identity claim':"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:a','letterboxd','abc',1,0,NULL)",
  'a metadata core field changes':"UPDATE film_metadata SET runtime=121 WHERE film_id='film:a'",
  'the coverage supplier proof moves':"UPDATE owner_review_authority SET generation=2 WHERE id=1",
 };
 for(const [label,sql] of Object.entries(cases)){
  const file=database();
  copyFilm(file,'film:a','1');
  const list=(await plan({DB:d1Standin(file)})).allowlist;
  const go=await goOf(list);
  const port=memory();
  const before=revision(file,'film:a');
  const run=await R.applyDimensionRetirement({DB:racing(file,sql)},{runId:'fence',allowlist:list,go,checkpoint:port,coverage,now:clock});
  assert.deepEqual([run.written.length,run.uncertain.length],[0,0],label+': nothing written');
  assert.ok(run.moved.length>0&&run.stopped===null,label+': reported moved, not stopped: '+JSON.stringify(run.moved[0]));
  assert.deepEqual(names(file,'film:a'),['fingerprint','identity','localization','metadata','prediction'],label+': every row is kept');
  assert.equal(receipts(file).filter(item=>item.state==='applied').length,0,label+': no applied receipt');
  assert.equal(revision(file,'film:a'),before,label+': no revision bump');
  assert.equal(port.log.settles[0][1].state,'not_applied',label+': settled as a definite refusal');
  accounted(run,list);
 }
 // the same change AFTER the checkpoint (inside record) and before the batch is refused too
 const file=database();
 copyFilm(file,'film:a','1');
 const env={DB:d1Standin(file)};
 const list=(await plan(env)).allowlist;
 const go=await goOf(list);
 const port=memory();
 const hooked={...port,record:async intent=>{await port.record(intent);exec(file,"UPDATE prediction_domain_authority SET generation=generation+1 WHERE id=1");}};
 const run=await R.applyDimensionRetirement(env,{runId:'after-checkpoint',allowlist:list,go,checkpoint:hooked,coverage,now:clock});
 assert.deepEqual([run.written.length,run.moved.length,names(file,'film:a').length],[0,3,5]);
 // the Film/Person marker moves after the classification and BEFORE the writer reads the marker itself (during the checkpoint): the writer must not adopt the new epoch
 const fileM=database();
 copyFilm(fileM,'film:a','1');
 const envM={DB:d1Standin(fileM)};
 const listM=(await plan(envM)).allowlist;
 const portM=memory();
 const movedM={...portM,record:async intent=>{await portM.record(intent);exec(fileM,"UPDATE film_person_authority SET cutover='held',generation=generation+1 WHERE id=1;UPDATE film_person_authority SET cutover='open',generation=generation+1 WHERE id=1");}};
 const runM=await R.applyDimensionRetirement(envM,{runId:'epoch',allowlist:listM,go:await goOf(listM),checkpoint:movedM,coverage,now:clock});
 assert.deepEqual([runM.written.length,runM.moved.length,runM.moved[0].code,names(fileM,'film:a').length],[0,3,'film_person_fence',5],'the batch is not built under an authority epoch the proof was not read under');
 // the same change BEFORE the read is simply part of the state read: nothing to refuse, and the intent carries the new token
 const file2=database();
 copyFilm(file2,'film:a','1');
 const env2={DB:d1Standin(file2)};
 const list2=(await plan(env2)).allowlist;
 exec(file2,"UPDATE prediction_domain_authority SET generation=generation+1 WHERE id=1");
 const run2=await apply(env2,list2);
 assert.deepEqual([run2.written.length,run2.written[0].proof.prediction],[1,2]);
 // a metadata-only intent is not fenced by a prediction marker it did not stand on
 const file3=database();
 copyFilm(file3,'film:a','1');
 const list3=(await plan({DB:d1Standin(file3)})).allowlist.filter(item=>item.dimension==='metadata');
 const run3=await R.applyDimensionRetirement({DB:racing(file3,"UPDATE prediction_domain_authority SET generation=generation+1 WHERE id=1")},{runId:'meta',allowlist:list3,go:await goOf(list3),checkpoint:memory(),coverage,now:clock});
 assert.deepEqual([run3.written.length,run3.written[0].proof.prediction,run3.written[0].proof.guards],[1,null,[]],'no global contention: only the domains the proof stood on are asserted');
}

// ---- 12. Restore: only an empty slot, only at the exact recorded post-delete revision; anything else is reported and the newer state kept ----
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
 const racer={DB:d1Standin(file5,{onBatch:async statements=>{if(statements.some(item=>/INSERT INTO film_dimension/.test(item.text)))exec(file5,dim('film:a','prediction',{status:'failed'}));}})};
 await assert.rejects(()=>R.restoreDimensionRetirement(racer,{runId:'undo-5',token:token5,now:clock}),code(R.RETIRE_RESTORE_MOVED));
 assert.deepEqual(dimRows(file5,'film:a').filter(row=>row.dimension==='prediction'),[{dimension:'prediction',status:'failed',authority:null}],'the racing writer is not overwritten');
 assert.equal(names(file5,'film:a').includes('fingerprint'),false,'and nothing was half restored');
}

// ---- 13. A restore token is validated and bound to its own applied receipt before any receipt is reserved ----
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
 await refuse({...token,approval:{...token.approval,reference:'https://example.test/forged'}},'film_person_invalid','another approval');
 await refuse({...token,approval:null},'film_person_invalid','no approval');
 await refuse({...token,proof:{...token.proof,claims:'x'}},'film_person_invalid','another proof');
 await refuse({...token,proof:{...token.proof,guards:[]}},'film_person_invalid','a prediction intent with no guards');
 await refuse({...token,proof:{...token.proof,guards:[{sql:'1=1',params:[{}]}]}},'film_person_invalid','a malformed guard');
 await refuse({...token,proof:null},'film_person_invalid','no proof');
 await refuse({...token,requestId:token.requestId+'x'},'film_person_invalid','another request identity');
 await refuse({...token,digest:'0'.repeat(64)},'film_person_invalid','another digest');
 await refuse({...token,postRevision:5},'film_person_invalid','another revision');
 await refuse({...token,id:'film:other'},'film_person_invalid','another target');
 // a well-formed intent that no applied receipt backs
 const file2=database();
 copyFilm(file2,'film:a','1');
 const env2={DB:d1Standin(file2)};
 const port=memory();
 const list2=(await plan(env2)).allowlist;
 await R.applyDimensionRetirement({DB:dead(file2)},{runId:'ghost',allowlist:list2,go:await goOf(list2),checkpoint:port,coverage,now:clock});
 const ghost=port.log.records[0];
 const b2=[everything(file2),receipts(file2).length];
 await assert.rejects(()=>R.restoreDimensionRetirement(env2,{runId:'rs-y',token:ghost,now:clock}),code(R.RETIRE_UNBOUND),'an intent with no applied receipt');
 assert.deepEqual([everything(file2),receipts(file2).length],b2);
 // a held marker refuses the restore
 exec(file,"UPDATE film_person_authority SET cutover='held',generation=generation+1 WHERE id=1");
 await assert.rejects(()=>R.restoreDimensionRetirement(env,{runId:'rs-z',token,now:clock}),code('film_person_held'));
}

// ---- 14. The safe-delete rule: the JS twin and the SQL twin agree over the same rows, and nothing protected matches ----
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

// ---- 15. Allowlist validation, the pure rule and dormancy ----
{
 const d='a'.repeat(64);
 const bad=[[],null,[{id:'film:a',dimension:'identity',rowDigest:d}],[{id:'film:a',dimension:'localization',rowDigest:d}],[{id:'person:a',dimension:'metadata',rowDigest:d}],[{id:'film:a',dimension:'metadata',rowDigest:'x'}],[{id:'film:a',dimension:'metadata',rowDigest:d,extra:1}],[{id:'film:a',dimension:'metadata',rowDigest:d},{id:'film:a',dimension:'metadata',rowDigest:d}]];
 for(const value of bad)assert.throws(()=>R.checkAllowlist(value),code('film_person_invalid'),JSON.stringify(value).slice(0,80));
 assert.equal(R.checkAllowlist(Array.from({length:500},(_,i)=>({id:'film:'+i,dimension:'metadata',rowDigest:d}))).length,500,'the approved list is the scope: no length ceiling');
 const sorted=R.checkAllowlist([{id:'film:b',dimension:'prediction',rowDigest:d},{id:'film:a',dimension:'metadata',rowDigest:d},{id:'film:a',dimension:'fingerprint',rowDigest:d}]);
 assert.deepEqual(sorted.map(keyOf),['film:a/fingerprint','film:a/metadata','film:b/prediction']);
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
