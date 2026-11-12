// AIR-374 P3-0b (ADR 0123): the producer-side receipt ADAPTER for the operation kind `film_facts`, dormant, on the sqlite3-CLI D1 stand-in. No Worker, R2, D1 or Cloudflare access. Covered: the route gate (one marker read at
// prepared, nothing else), the digest and the stable request id (event, target and content; never the content alone), the pre-plan that skips a no-op BEFORE a receipt exists, the atomic write (2 batches: the pending insert and the
// writer's own), the E5 race (identical content landing between pre-plan and writer: `unknown`, readback, reconcile, never a second marking batch), a stale revision (proceed / superseded by re-validation), the origin filter of
// `listReceipts` and `reconcileReceipts`, the bounded inline reconcile by the producer's own origin (E2), and the static dormancy. ADAPTER_SRC points the file at a mutant copy of src/ (tests/canonical-producer-adapters-mutation.mjs);
// ADAPTER_TEMPLATE a prebuilt template database.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const SRC=process.env.ADAPTER_SRC?path.resolve(process.env.ADAPTER_SRC):path.resolve('src');
const load=name=>import(pathToFileURL(path.join(SRC,name)).href);
const A=await load('canonical-producer-adapters.js');
const R=await load('canonical-receipts.js');
const {writeFilmFacts}=await load('canonical-film-writers.js');
const {applyFilmFacts,reconcileOwnOrigin,filmFactsDigest,filmFactsOperation,producerRequestId,prePlanFilmFacts,INLINE_RECONCILE_LIMIT}=A;
const {readAuthority}=await load('film-person-authority.js');
const {listReceipts,reconcileReceipts,listAttention,operationRegistry,defineOperation,requestIdOf,normalizeRequest,OPERATION_KINDS,readReceipt}=R;

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-producer-adapters-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const template=path.join(root,'template.sqlite');
if(process.env.ADAPTER_TEMPLATE)fs.copyFileSync(process.env.ADAPTER_TEMPLATE,template);
else{
 const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
 assert.equal(sqlite(template,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
}
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:00.000Z');";
let n=0;
function database(stage='open',{baseline=true}={}){
 const file=path.join(root,'a-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 if(['r2','prepared','open','held'].includes(stage))assert.equal(sqlite(file,VERIFY).status,0);
 if(['prepared','open','held'].includes(stage))assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1").status,0);
 if(stage==='open'||stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1").status,0);
 if(stage==='open'&&baseline)assert.equal(sqlite(file,BASELINE).status,0);
 if(stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);
 return file;
}
const envOf=(file,options)=>({DB:d1Standin(file,options)});
const code=expected=>error=>error.code===expected;
const T='2026-11-11T10:00:00.000Z';
const iso=ms=>new Date(Date.parse(T)+ms).toISOString();
const FILM='film:tmdb:603';
const META=(over={})=>({schemaVersion:1,year:1999,runtime:136,synopsis:'A hacker learns the truth.',poster:'/p.jpg',url:'https://example.test/m',genres:['sci-fi'],peopleVersion:2,payload:{k:'v'},r2Key:null,contentSha256:null,updatedAt:T,...over});
const facts=(over={})=>({id:FILM,at:T,film:{contractVersion:1,originalTitle:'Title A',source:'tmdb'},metadata:META(),sync:{metadataAt:T,synopsisFetchedAt:T,peopleNamesVersion:2,peopleLocalizedAt:T},watchlist:true,...over});
const receipts=file=>rows(file,'SELECT request_id,operation,origin,target_id,state,attempts,planned_revision,applied_revision,error_class FROM canonical_write_receipt ORDER BY created_at,request_id');
const revision=(file,id=FILM)=>Number(one(file,"SELECT revision FROM canonical_revision WHERE kind='film' AND id='"+id+"'")??0);
const dump=file=>JSON.stringify(['film','film_metadata','film_sync_state','watchlist_film','film_dimension','canonical_revision','canonical_write_receipt'].map(table=>[table,rows(file,'SELECT * FROM '+table+' ORDER BY 1,2')]));
const title=(file,id=FILM)=>one(file,"SELECT original_title FROM film WHERE id='"+id+"'");
const apply=(env,over={})=>applyFilmFacts(env,{origin:'epg',event:'run-1',input:facts(),now:()=>T,...over});
// A direct interloper write (another actor reaching a Film), without any receipt.
const interlope=(file,input,expectedRevision)=>writeFilmFacts(envOf(file),{...input,requestId:'interloper',expectedRevision});
// Hooks the SECOND batch of an adapter run (the writer's own) once: the pending insert is the first.
const raceAt=(file,index,action)=>{let seen=0;return envOf(file,{onBatch:async()=>{seen++;if(seen===index)await action();}});};
const ops=input=>operationRegistry([filmFactsOperation({replan:async()=>input,now:()=>T})]);

// 1. The route gate: at r2 and prepared exactly ONE marker read (the queries of readAuthority, all SELECTs) and no batch; held throws; nothing is written, no receipt.
for(const stage of ['r2','prepared']){
 const file=database(stage),before=dump(file);
 const probe=envOf(file);await readAuthority(probe);
 const markerQueries=probe.DB.calls.queries;
 const seen=[];
 const env=envOf(file,{onQuery:async text=>{seen.push(text);}});
 const done=await apply(env);
 assert.deepEqual(done,{state:'skipped',reason:'projector_is_writer',receipt:false},stage);
 assert.equal(env.DB.calls.queries,markerQueries,stage+': exactly one marker read');
 assert.ok(seen.every(text=>/^\s*SELECT/i.test(text)),stage+': only SELECTs');
 assert.equal(env.DB.calls.batches,0,stage+': no batch');
 const reconciled=await reconcileOwnOrigin(env,{origin:'epg',operations:ops(facts())});
 assert.equal(reconciled.skipped,true,stage+': reconcile skipped');
 assert.equal(env.DB.calls.queries,2*markerQueries,stage+': the reconcile reads only the marker');
 assert.equal(dump(file),before,stage+': nothing written');
}
{
 const file=database('held'),env=envOf(file);
 await assert.rejects(()=>apply(env),code('film_person_held'));
 await assert.rejects(()=>reconcileOwnOrigin(env,{origin:'epg',operations:ops(facts())}),code('film_person_held'));
 assert.equal(env.DB.calls.batches,0);
}

// 2. Digest and request id. The digest is the planned CONTENT (clocks dropped at every depth, key order irrelevant); the request id adds the source event and the target.
{
 const base=await filmFactsDigest(facts());
 assert.match(base,/^[0-9a-f]{64}$/);
 assert.equal(await filmFactsDigest(facts({at:iso(5000),metadata:META({updatedAt:iso(9000)}),updatedAt:iso(1)})),base,'at and updatedAt (at any depth) are not content');
 assert.equal(await filmFactsDigest(facts({evidence:{verified:true,at:T}})),await filmFactsDigest(facts({evidence:{verified:true,at:iso(7000)}})),'a nested write clock is not content');
 assert.equal(await filmFactsDigest({watchlist:true,sync:facts().sync,metadata:META(),film:{source:'tmdb',originalTitle:'Title A',contractVersion:1},at:T,id:FILM}),base,'key order is not content');
 assert.notEqual(await filmFactsDigest(facts({film:{contractVersion:1,originalTitle:'Title B',source:'tmdb'}})),base,'content changes the digest');
 assert.notEqual(await filmFactsDigest(facts({id:'film:tmdb:604'})),base,'the target is part of the digest');
 assert.notEqual(await filmFactsDigest(facts({sync:{...facts().sync,metadataAt:iso(1000)}})),base,'an observation time inside the facts is content');
 await assert.rejects(()=>filmFactsDigest({...facts(),id:'person:x'}),code('film_person_invalid'));
 const target={kind:'film',id:FILM};
 const id=await producerRequestId({origin:'epg',event:'run-1',target,digest:base});
 assert.equal(id,await producerRequestId({origin:'epg',event:'run-1',target,digest:base}),'the same event and content: the same id');
 assert.match(id,/^epg:film_facts:[0-9a-f]{64}$/);
 assert.notEqual(id,await producerRequestId({origin:'epg',event:'run-2',target,digest:base}),'another event: another id');
 assert.notEqual(id,await producerRequestId({origin:'epg',event:'run-1',target,digest:await filmFactsDigest(facts({film:{contractVersion:1,originalTitle:'Title B'}}))}),'another content: another id');
 assert.notEqual(id,await producerRequestId({origin:'epg',event:'run-1',target:{kind:'film',id:'film:tmdb:604'},digest:base}),'another target: another id');
 assert.notEqual(id.replace(/^epg/,'x'),await producerRequestId({origin:'discovery',event:'run-1',target,digest:base}));
 for(const bad of [{event:undefined},{event:''},{event:'  '},{event:7},{event:'e'.repeat(301)},{target:{kind:'film',id:'person:x'}},{target:{kind:'other',id:'film:x'}},{target:{kind:'other',id:'other:x'}},{target:undefined},{digest:'abc'},{digest:undefined}])
  await assert.rejects(()=>producerRequestId({origin:'epg',event:'run-1',target,digest:base,...bad}),code('film_person_invalid'),JSON.stringify(Object.keys(bad)));
 assert.ok(OPERATION_KINDS.includes('film_facts'));
 assert.equal(await requestIdOf({origin:'epg',operation:'film_facts',source:{a:1}}).then(Boolean),true);
 assert.equal(normalizeRequest({requestId:id,operation:'film_facts',origin:'epg',target,expectedRevision:0,digest:base}).operation,'film_facts');
}

// 3. The happy path: one pending insert and ONE writer batch (the applied receipt is inside it), applied at the revision the batch produced; the same event again is a no-op with no receipt and no batch.
{
 const file=database('open');
 const batches=[];
 const env=envOf(file,{onBatch:async statements=>{batches.push(statements.map(item=>item.text));}});
 const done=await apply(env);
 assert.equal(done.state,'applied');
 assert.equal(done.attempt,1);
 assert.equal(batches.length,2,'a pending insert and one writer batch, no marking batch');
 assert.ok(!batches[0].some(text=>/INSERT INTO film\b/.test(text)),'the first batch is only the receipt insert');
 assert.equal(batches[1].filter(text=>/canonical_write_receipt/.test(text)).length,1,'the receipt is applied inside the writer batch');
 const stored=receipts(file);
 assert.equal(stored.length,1);
 assert.deepEqual([stored[0].operation,stored[0].origin,stored[0].target_id,stored[0].state,stored[0].attempts,stored[0].planned_revision,stored[0].applied_revision],['film_facts','epg',FILM,'applied',1,0,1]);
 assert.equal(stored[0].request_id,done.requestId);
 assert.equal(title(file),'Title A');
 assert.equal(Number(one(file,'SELECT COUNT(*) FROM watchlist_film')),1);
 assert.equal(revision(file),1);
 // the same facts again (even another event, another clock): a no-op BEFORE any receipt
 for(const over of [{},{event:'run-2'},{input:facts({at:iso(9000),metadata:META({updatedAt:iso(9000)})}),event:'run-3'}]){
  const again=await apply(env,over);
  assert.equal(again.state,'noop');assert.equal(again.receipt,false);
 }
 assert.equal(batches.length,2,'a no-op opens no batch at all');
 assert.equal(receipts(file).length,1,'a no-op creates no receipt');
 assert.equal(revision(file),1,'the revision did not move');
}

// 3b. The writer stores the receipt's own request id on the localization source rows it writes (the request id the adapter handed over is the receipt's, not another).
{
 const file=database('open'),env=envOf(file);
 const input=facts({id:'film:tmdb:700',localization:{sources:[{source:'wikidata',value:'Value',sourceVersion:'v1',provenance:{},observedAt:T}]}});
 const done=await apply(env,{input});
 assert.equal(done.state,'applied');
 assert.equal(one(file,"SELECT request_id FROM film_localization_source WHERE film_id='film:tmdb:700'"),done.requestId);
}

// 4. A no-op against stored content creates no receipt (content written by the projector or by another producer), and a refusal before any receipt exists leaves nothing behind.
{
 const file=database('open');
 await interlope(file,facts(),0);
 const env=envOf(file);
 const done=await apply(env);
 assert.equal(done.state,'noop');
 assert.equal(env.DB.calls.batches,0);
 assert.equal(receipts(file).length,0);
 const before=dump(file);
 await assert.rejects(()=>apply(env,{input:facts({film:{originalTitle:'No contract version'}}),event:'run-9'}),code('film_person_invalid'));
 await assert.rejects(()=>apply(env,{event:undefined}),code('film_person_invalid'));
 await assert.rejects(()=>apply(env,{origin:'EPG'}),code('film_person_invalid'));
 assert.equal(env.DB.calls.batches,0,'no batch for a refused input');
 assert.equal(dump(file),before);
}

// 5. Without the activation baseline the adapter writes nothing (no receipt can exist, so nothing canonical may be written).
{
 const file=database('open',{baseline:false}),before=dump(file);
 await assert.rejects(()=>apply(envOf(file)),code('receipt_baseline_missing'));
 assert.equal(dump(file),before);
 assert.equal(Number(one(file,'SELECT COUNT(*) FROM film')),0);
}

// 6. A source event is never replaced by content: A, then B, then A again under NEW events is three requests (three receipts, final content A). The same event id for the second A is the producer's bug: it is an already
// applied request and is not run again, which is exactly why the event is mandatory and must be unique per observation.
{
 const file=database('open'),env=envOf(file);
 const a=facts(),b=facts({film:{contractVersion:1,originalTitle:'Title B',source:'tmdb'}});
 const r1=await apply(env,{input:a,event:'run-1'});
 const r2=await apply(env,{input:b,event:'run-2'});
 const r3=await apply(env,{input:a,event:'run-3'});
 assert.deepEqual([r1.state,r2.state,r3.state],['applied','applied','applied']);
 assert.equal(new Set([r1.requestId,r2.requestId,r3.requestId]).size,3,'three distinct request ids for A, B, A');
 assert.equal(title(file),'Title A');
 assert.equal(revision(file),3);
 assert.equal(receipts(file).filter(row=>row.state==='applied').length,3);
 const reused=await apply(env,{input:a,event:'run-1'});
 assert.equal(reused.state,'noop','the content is already stored');
 const stale=await apply(env,{input:b,event:'run-2'});
 assert.equal(stale.already,true,'a reused event with other stored content is read as already applied: the event must be unique per observation');
 assert.equal(title(file),'Title A');
}

// 7. E5: identical content lands between the pre-plan and the writer's own read. The writer finds nothing to write, opens no batch, and the receipt ends `unknown` (atomic_mark_missing): never a second marking batch.
// It is visible in listAttention and settled by readback: the content is there but unproven, so it goes to review.
let raced;
{
 const file=database('open');
 const env=raceAt(file,1,async()=>{await interlope(file,facts(),0);});
 const done=await apply(env);
 assert.equal(done.state,'unknown');
 assert.equal(done.errorClass,'atomic_mark_missing');
 assert.equal(done.needsReview,true);
 assert.equal(env.DB.calls.batches,2,'the pending insert and the transition to unknown; the writer opened no batch');
 const row=receipts(file);
 assert.equal(row.length,1);
 assert.deepEqual([row[0].state,row[0].error_class,row[0].applied_revision],['unknown','atomic_mark_missing',null]);
 assert.equal(Number(one(file,"SELECT COUNT(*) FROM canonical_write_receipt WHERE state='applied'")),0,'no applied receipt was fabricated');
 assert.equal(revision(file),1,'the interloper revision only');
 const attention=await listAttention(env);
 assert.equal(attention.length,1);assert.equal(attention[0].needsReview,true);
 // before the backoff passes nothing happens; after it, the inline reconcile reads the content back: present but unproven -> needs review, abandoned, nothing written
 const early=await reconcileOwnOrigin(env,{origin:'epg',operations:ops(facts()),now:()=>iso(1000)});
 assert.equal(early.considered,0);
 const late=await reconcileOwnOrigin(envOf(file),{origin:'epg',operations:ops(facts()),now:()=>iso(61000)});
 assert.deepEqual(late.needsReview,[row[0].request_id]);
 assert.equal(revision(file),1,'reconcile wrote nothing');
 assert.equal(receipts(file)[0].error_class,'content_match_unproven');
 raced=row[0].request_id;
}

// 8. A stale revision. Another actor changes the Film between the pre-plan and the writer's batch: the batch is refused whole (`failed`, retryable, the revision conflict is thrown after the receipt is marked). The inline reconcile
// re-validates against the CURRENT rows: the facts would still change something -> proceed, the SAME request id is replayed at the current revision and applied; the facts would change nothing -> superseded, abandoned, no write.
{
 const file=database('open');
 const env=raceAt(file,2,async()=>{await interlope(file,{id:FILM,at:T,film:{contractVersion:1},sync:{metadataAt:iso(500)}},0);});
 await assert.rejects(()=>apply(env),code('film_person_revision_conflict'));
 const failedRow=receipts(file)[0];
 assert.deepEqual([failedRow.state,failedRow.error_class,failedRow.attempts],['failed','film_person_revision_conflict',1]);
 assert.equal(title(file),null,'the refused batch wrote nothing of ours');
 const own=envOf(file);
 const result=await reconcileOwnOrigin(own,{origin:'epg',operations:ops(facts()),now:()=>iso(61000)});
 assert.deepEqual(result.replayed,[failedRow.request_id],'the same request id is replayed');
 const done=receipts(file);
 assert.equal(done.length,1,'no second receipt');
 assert.deepEqual([done[0].state,done[0].attempts,done[0].planned_revision,done[0].applied_revision],['applied',2,1,2]);
 assert.equal(title(file),'Title A');
 assert.equal(revision(file),2);
 assert.equal(one(file,'SELECT metadata_at FROM film_sync_state'),T,'our sync clock was written over the interloper one by the same field-wise merge');
}
{
 const file=database('open');
 const env=raceAt(file,2,async()=>{await interlope(file,facts(),0);});
 await assert.rejects(()=>apply(env),code('film_person_revision_conflict'));
 const result=await reconcileOwnOrigin(envOf(file),{origin:'epg',operations:ops(facts()),now:()=>iso(61000)});
 assert.equal(result.replayed.length,0);
 assert.equal(result.needsReview.length,1,'the content is there without proof of this request: review, never applied');
 assert.equal(revision(file),1,'nothing was written');
}

// 8b. The same event again, through applyFilmFacts, after the failure: the existing receipt is settled by readback and retried with the SAME request id, planned against the CURRENT revision even when another actor
// advanced it after the pre-plan, on attempt 2.
{
 const file=database('open');
 const first=raceAt(file,2,async()=>{await interlope(file,{id:FILM,at:T,film:{contractVersion:1},sync:{metadataAt:iso(500)}},0);});
 await assert.rejects(()=>apply(first),code('film_person_revision_conflict'));
 const failedRow=receipts(file)[0];
 let fired=false;
 const second=envOf(file,{onQuery:async text=>{if(!fired&&/FROM canonical_write_receipt WHERE request_id/.test(text)){fired=true;await interlope(file,{id:FILM,at:T,film:{contractVersion:1},sync:{metadataAt:iso(700)}},1);}}});
 const done=await apply(second,{now:()=>iso(61000)});
 assert.equal(fired,true);
 assert.equal(done.requestId,failedRow.request_id,'the same request id');
 assert.equal(done.state,'applied');
 assert.equal(done.attempt,2);
 const row=receipts(file);
 assert.equal(row.length,1);
 assert.deepEqual([row[0].state,row[0].attempts,row[0].planned_revision,row[0].applied_revision],['applied',2,2,3]);
 assert.equal(revision(file),3);
 assert.equal(title(file),'Title A');
}

// 9. The operation spec: atomic, registered, and its replay and readback refuse a source that moved on or cannot be re-planned.
{
 const spec=filmFactsOperation({replan:async()=>facts()});
 assert.equal(spec.atomic,true);assert.equal(spec.operation,'film_facts');assert.equal(typeof spec.revalidate,'function');
 assert.equal(operationRegistry([spec]).get('film_facts'),spec);
 assert.throws(()=>filmFactsOperation({}),code('film_person_invalid'));
 const file=database('open'),env=envOf(file);
 const digest=await filmFactsDigest(facts());
 const target={kind:'film',id:FILM};
 const receipt={requestId:await producerRequestId({origin:'epg',event:'e',target,digest}),operation:'film_facts',origin:'epg',target,contentDigest:digest,plannedRevision:0,state:'failed',attempts:1};
 const ctx={requestId:receipt.requestId,attempt:2,target,currentRevision:0};
 const moved=filmFactsOperation({replan:async()=>facts({film:{contractVersion:1,originalTitle:'Other'}})});
 await assert.rejects(()=>moved.replay(env,receipt,ctx),code('film_person_invalid'),'a re-plan with other content is never replayed');
 assert.deepEqual(await moved.readback(env,target,receipt),{disposition:'abandon',errorClass:'producer_source_changed'},'a changed re-plan is a typed terminal disposition, not an exception');
 assert.equal(await moved.revalidate(env,receipt,{currentRevision:1}),'stale');
 const other=filmFactsOperation({replan:async()=>facts({id:'film:tmdb:604'})});
 await assert.rejects(()=>other.replay(env,receipt,ctx),code('film_person_invalid'),'another target is never replayed');
 const none=filmFactsOperation({replan:async()=>null});
 await assert.rejects(()=>none.replay(env,receipt,ctx),code('producer_replan_unavailable'));
 assert.deepEqual(await none.readback(env,target,receipt),{digest:null,revision:0},'no re-plan reads as an absent effect (bounded retry), never as a terminal disposition');
 const throwing=filmFactsOperation({replan:async()=>{throw new Error('producer down');}});
 assert.deepEqual(await throwing.readback(env,target,receipt),{digest:null,revision:0},'a throwing re-plan is unavailable, not a crash');
 assert.equal(await none.revalidate(env,receipt,{currentRevision:1}),'stale');
 const plan=await prePlanFilmFacts(env,{input:facts(),requestId:receipt.requestId});
 assert.deepEqual([plan.noop,plan.expectedRevision],[false,0]);
 assert.equal(await spec.revalidate(env,receipt,{currentRevision:1}),'proceed','the facts would still change the Film');
 await interlope(file,facts(),0);
 assert.equal(await spec.revalidate(envOf(file),receipt,{currentRevision:1}),'superseded','the facts would change nothing any more');
 assert.equal(env.DB.calls.batches,0,'none of these wrote through the adapter');
}

// 10. The origin filter: in SQL (another origin's rows never use up the limit), an invalid origin is refused, and the reconcile of one origin never touches another's receipts.
{
 const file=database('open');
 const insert=(id,origin,at)=>"INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at) VALUES ('"+id+"','film_facts','"+origin+"','film','film:tmdb:"+id.replace(/\D/g,'')+"','"+'a'.repeat(64)+"',0,2,'pending',1,'"+at+"','"+T+"','"+T+"')";
 const text=[];
 for(let i=1;i<=12;i++)text.push(insert('epg:film_facts:'+i,'epg',iso(i)));
 text.push(insert('discovery:film_facts:90','discovery',iso(100)));
 text.push(insert('discovery:film_facts:91','discovery',iso(101)));
 assert.equal(sqlite(file,text.join(';\n')).status,0);
 const env=envOf(file);
 const due=iso(10*60*1000);
 assert.equal((await listReceipts(env,{dueBefore:due,limit:50})).length,14,'no origin: all of them');
 assert.deepEqual((await listReceipts(env,{dueBefore:due,limit:50,origin:'discovery'})).map(row=>row.origin),['discovery','discovery']);
 assert.equal((await listReceipts(env,{dueBefore:due,limit:1,origin:'discovery'})).length,1,'the limit counts only the origin');
 assert.equal((await listReceipts(env,{dueBefore:due,limit:50,origin:'nobody'})).length,0);
 for(const bad of ['EPG','a b','',"x';--"])await assert.rejects(()=>listReceipts(env,{origin:bad}),code('film_person_invalid'));
 const untouched=envOf(file);
 await assert.rejects(()=>reconcileReceipts(untouched,{operations:new Map(),origin:'Bad'}),code('film_person_invalid'));
 assert.equal(untouched.DB.calls.queries,0,'an invalid origin is refused before any statement');
 // the registry cannot re-plan anything: every readback is refused, nothing is written, and only the own origin is considered, at most INLINE_RECONCILE_LIMIT of it
 const none=operationRegistry([defineOperation({operation:'film_facts',atomic:true,readback:async()=>{throw new Error('database unreadable');},replay:async()=>{throw new Error('never');}})]);
 const inline=await reconcileOwnOrigin(env,{origin:'epg',operations:none,limit:50,now:()=>due});
 assert.equal(INLINE_RECONCILE_LIMIT,10);
 assert.equal(inline.considered,10,'bounded by the inline limit');
 assert.equal(inline.origin,'epg');
 assert.equal(inline.waiting.length,10);
 assert.ok(inline.waiting.every(item=>item.reason==='readback_failed'&&item.requestId.startsWith('epg:')),'only the own origin');
 const wide=await reconcileReceipts(env,{operations:none,origin:'discovery',limit:50,now:()=>due});
 assert.equal(wide.considered,2);
 const all=await reconcileReceipts(env,{operations:none,limit:50,now:()=>due});
 assert.equal(all.considered,14,'the global pass still exists for the receipts module');
 await assert.rejects(()=>reconcileOwnOrigin(env,{operations:none}),code('film_person_invalid'));
 await assert.rejects(()=>reconcileOwnOrigin(env,{origin:'epg'}),code('film_person_invalid'));
 const clamp=await reconcileOwnOrigin(env,{origin:'epg',operations:none,limit:0,now:()=>due});
 assert.equal(clamp.considered,1,'a limit of 0 is raised to 1');
 assert.equal(Number(one(file,"SELECT COUNT(*) FROM canonical_write_receipt WHERE state='pending'")),14,'nothing was settled');
 void readReceipt;void raced;
}

// A due receipt of the unchanged source whose revision has not moved (pending since T, due after the 120 s attempt window).
const seeded=async()=>{
 const file=database('open');
 const digest=await filmFactsDigest(facts());
 const requestId=await producerRequestId({origin:'epg',event:'run-1',target:{kind:'film',id:FILM},digest});
 assert.equal(sqlite(file,"INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at) VALUES ('"+requestId+"','film_facts','epg','film','"+FILM+"','"+digest+"',0,2,'pending',1,'"+iso(120000)+"','"+T+"','"+T+"')").status,0);
 return {file,row:{request_id:requestId}};
};
// 12. A CHANGED SOURCE end to end (ADR 0123 decision 5). A due failed receipt whose re-plan digests differently is abandoned `producer_source_changed` by the inline reconcile: same request id, attempts untouched, no replay, no
// canonical write, no second receipt, visible in listAttention.
const dueFailed=async()=>{
 const file=database('open');
 const env=raceAt(file,2,async()=>{await interlope(file,{id:FILM,at:T,film:{contractVersion:1},sync:{metadataAt:iso(500)}},0);});
 await assert.rejects(()=>apply(env),code('film_person_revision_conflict'));
 const row=receipts(file)[0];
 assert.deepEqual([row.state,row.attempts],['failed',1]);
 return {file,row,before:dump(file).replace(/"updated_at":"[^"]*"/g,'')};
};
{
 const {file,row}=await dueFailed();
 const writes=dump(file);
 const moved=operationRegistry([filmFactsOperation({replan:async()=>facts({film:{contractVersion:1,originalTitle:'Other'}}),now:()=>T})]);
 const own=envOf(file);
 const result=await reconcileOwnOrigin(own,{origin:'epg',operations:moved,now:()=>iso(61000)});
 assert.deepEqual(result.abandoned,[{requestId:row.request_id,reason:'producer_source_changed'}]);
 assert.deepEqual([result.replayed.length,result.waiting.length,result.failed.length,result.applied.length,result.needsReview.length],[0,0,0,0,0]);
 const after=receipts(file);
 assert.equal(after.length,1,'no second receipt');
 assert.deepEqual([after[0].request_id,after[0].state,after[0].attempts,after[0].error_class,after[0].applied_revision],[row.request_id,'abandoned',1,'producer_source_changed',null]);
 assert.notEqual(one(file,'SELECT settled_at FROM canonical_write_receipt'),null,'abandoned is settled');
 assert.equal(title(file),null,'the old facts were never written');
 assert.equal(revision(file),1,'no canonical write');
 assert.equal(own.DB.calls.batches,1,'the one abandon transition and nothing else');
 assert.ok(JSON.stringify(await listAttention(own)).includes('producer_source_changed'),'reviewable');
 const again=await reconcileOwnOrigin(envOf(file),{origin:'epg',operations:moved,now:()=>iso(10*60*60*1000)});
 assert.equal(again.considered,0,'terminal: never reconsidered');
 void writes;
}
// the same source change met on the natural path (applyFilmFacts of the same event after the failure) settles the receipt without a write too
{
 const {file,row}=await dueFailed();
 const done=await applyFilmFacts(envOf(file),{origin:'epg',event:'run-1',input:facts(),replan:async()=>facts({film:{contractVersion:1,originalTitle:'Other'}}),now:()=>iso(61000)});
 assert.deepEqual([done.state,done.reason,done.requestId],['abandoned','producer_source_changed',row.request_id]);
 assert.equal(title(file),null);assert.equal(revision(file),1);
 assert.equal(receipts(file)[0].error_class,'producer_source_changed');
}
// A transient or absent re-plan stays retryable but BOUNDED: each inline pass counts an attempt (backoff applies), and after maxAttempts the receipt is abandoned `attempts_exhausted`; never a write.
{
 const {file,row}=await seeded();
 const gone=operationRegistry([filmFactsOperation({replan:async()=>null,now:()=>T})]);
 let at=121000,seen=[];
 for(let pass=0;pass<8;pass++){
  const env=envOf(file);
  const result=await reconcileOwnOrigin(env,{origin:'epg',operations:gone,now:()=>iso(at)});
  const state=receipts(file)[0];
  seen.push([state.state,state.attempts,state.error_class]);
  if(state.state==='abandoned')break;
  at+=3*60*60*1000;
  void result;
 }
 assert.deepEqual(seen[0],['unknown',2,'producer_replan_unavailable'],'the first unavailable pass counts an attempt and backs off');
 assert.deepEqual(seen.at(-1),['abandoned',5,'attempts_exhausted'],JSON.stringify(seen));
 assert.ok(seen.length<=5);
 assert.equal(title(file),undefined);assert.equal(revision(file),0,'no write');
 assert.equal(receipts(file).length,1);
 void row;
}
// A producer whose re-plan throws behaves like an absent one (counted), and an unreadable database waits only until the receipt's age bound, then abandons `readback_expired`.
{
 const {file,row}=await seeded();
 const boom=operationRegistry([filmFactsOperation({replan:async()=>{throw new Error('producer down');},now:()=>T})]);
 await reconcileOwnOrigin(envOf(file),{origin:'epg',operations:boom,now:()=>iso(121000)});
 assert.deepEqual([receipts(file)[0].state,receipts(file)[0].attempts],['unknown',2]);
 const bad=operationRegistry([defineOperation({operation:'film_facts',atomic:true,readback:async()=>{throw new Error('database unreadable');},replay:async()=>{throw new Error('never');}})]);
 const week=8*24*60*60*1000;
 const fresh=await reconcileOwnOrigin(envOf(file),{origin:'epg',operations:bad,now:()=>iso(3*60*60*1000)});
 assert.deepEqual(fresh.waiting.map(item=>item.reason),['readback_failed']);
 assert.equal(receipts(file)[0].state,'unknown','a young receipt keeps waiting');
 const old=await reconcileOwnOrigin(envOf(file),{origin:'epg',operations:bad,now:()=>iso(week)});
 assert.deepEqual(old.abandoned,[{requestId:row.request_id,reason:'readback_expired'}],JSON.stringify(old));
 assert.equal(receipts(file)[0].error_class,'readback_expired');
 assert.equal(revision(file),0);
}

// A malformed disposition is not a disposition: it is an ordinary observation of an absent effect (bounded retry), never an abandon with an arbitrary class.
{
 const {file}=await seeded();
 let replays=0;
 const odd=operationRegistry([defineOperation({operation:'film_facts',atomic:true,readback:async()=>({disposition:'abandon',errorClass:'Bad Class!'}),replay:async()=>{replays++;throw new Error('replayed');}})]);
 const result=await reconcileOwnOrigin(envOf(file),{origin:'epg',operations:odd,now:()=>iso(121000)});
 assert.equal(result.abandoned.length,0);assert.equal(replays,1,'treated as an absent effect');
}

// 11. Static: dormant. No source file imports the adapter, build.mjs does not bundle it, it names no network, storage, timer or cron API, and it imports exactly the modules it is allowed to.
{
 const adapters='src/canonical-producer-adapters.js';
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&full!==adapters&&fs.readFileSync(full,'utf8').includes('canonical-producer-adapters'))importers.push(full);}};
 walk('src');
 assert.deepEqual(importers,['src/canonical-dictionary-producer.js','src/canonical-epg-person-producer.js','src/canonical-epg-producer.js','src/canonical-person-adapters.js'],'only the dormant EPG and dictionary-store producer layers and the dormant Person adapters (ADR 0126) import the adapter');
 for(const file of ['build.mjs','package.json','wrangler.toml','wrangler.jsonc'])if(fs.existsSync(file))assert.ok(!fs.readFileSync(file,'utf8').includes('canonical-producer-adapters'),file+' does not bundle it');
 const text=fs.readFileSync(path.join(SRC,'canonical-producer-adapters.js'),'utf8');
 const code_=text.replace(/\/\/.*$/gm,'');
 assert.deepEqual([...text.matchAll(/from '(\.\/[^']+)'/g)].map(match=>match[1]).sort(),['./canonical-film-writers.js','./canonical-producers.js','./canonical-receipts.js','./film-person-authority.js']);
 assert.ok(!/\b(fetch|setTimeout|setInterval|scheduled|R2|BUCKET|waitUntil)\b/.test(code_),'no network, timer, cron or R2 reference');
 assert.ok(!/\b(INSERT|UPDATE|DELETE)\b\s+(INTO|FROM)?\s*\w/.test(code_),'the adapter holds no SQL of its own');
 assert.ok(!fs.readFileSync('src/worker.js','utf8').includes('producer-adapters'),'the Worker does not name it');
}
console.log('canonical-producer-adapters: ok');
