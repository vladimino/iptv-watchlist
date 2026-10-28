import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {manifestFor} from '../scripts/migration-export.mjs';
import {loadPlan,plan,rehearse,remote,workerContext} from '../scripts/prediction-versions-materialize.mjs';

// ADR-0026: historical prediction records become write-once version objects and the bundle gains pointers, through a gated,
// bounded Worker operation under the prediction writer lease. No prediction value changes; a changed bundle is never overwritten.
const sha256=text=>createHash('sha256').update(Buffer.from(text,'utf8')).digest('hex');
function bucket(){
 const records=new Map(),etags=new Map();let revision=0,fail=null;
 return {records,etags,failOnce(predicate){fail=predicate;},
  async get(key){return records.has(key)?{etag:etags.get(key),text:async()=>records.get(key),json:async()=>JSON.parse(records.get(key))}:null;},
  async put(key,value,options={}){if(fail&&fail(key)){fail=null;throw new Error('injected failure: '+key);}const c=options.onlyIf||{};if(c.etagDoesNotMatch==='*'&&records.has(key)||c.etagMatches&&c.etagMatches!==etags.get(key))return null;records.set(key,String(value));etags.set(key,'e'+(++revision));return {etag:etags.get(key)};},
  async delete(key){records.delete(key);},async list(){return {objects:[],truncated:false};}};
}
const ctx=workerContext(),rules=ctx.worker&&(await import('node:vm')).default.runInContext('({predictionVersionText,predictionVersionKey,predictionVersionBody,predictionMaterializationPlan})',ctx);
const post=async(env,body)=>{const response=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/predictions/materialize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env);return {status:response.status,data:await response.json()};};
const legacy=id=>({current:{filmId:id,predictedRating:4,generatedAt:'2026-10-26T09:00:00.000Z',tasteProfileVersion:1,moodLabels:['tense']},history:[{filmId:id,predictedRating:3,generatedAt:'2026-10-25T09:00:00.000Z',tasteProfileVersion:1,replacedAt:'2026-10-26T09:00:00.000Z'}]});
const bundleKey=id=>'enrichment/films/'+encodeURIComponent(id)+'/predictions.json';
const seed=(b,id,value=legacy(id))=>{const text=JSON.stringify(value);b.records.set(bundleKey(id),text);b.etags.set(bundleKey(id),'seed-'+id);return {filmId:id,expectedEtag:'seed-'+id,expectedSha256:sha256(text)};};
const PLAN='a'.repeat(64);

// 1. Gate and strict input; a dry run reads only (no lease, no receipt) and works with the gate off.
{
 const b=bucket(),item=seed(b,'tmdb_1');
 assert.equal((await post({BUCKET:b},{planId:PLAN,batch:0,items:[item]})).data.reason,'materialization_off');
 assert.equal((await post({BUCKET:b,PREDICTION_MATERIALIZATION:'on'},{planId:PLAN,batch:0,items:[item]})).data.reason,'version_objects_off','writing needs the version writer on too');
 const dry=await post({BUCKET:b},{planId:PLAN,batch:0,items:[item],dryRun:true});
 assert.equal(dry.status,200);assert.deepEqual(dry.data.outcomes,{would_materialize:1});
 assert.deepEqual([...b.records.keys()],[bundleKey('tmdb_1')],'a dry run writes nothing, not even the lease');
 const on={BUCKET:b,PREDICTION_MATERIALIZATION:'on',PREDICTION_VERSION_OBJECTS:'on'};
 for(const bad of [{planId:'x',batch:0,items:[item]},{planId:PLAN,batch:-1,items:[item]},{planId:PLAN,batch:0,items:[]},{planId:PLAN,batch:0,items:[item,item]},{planId:PLAN,batch:0,items:[{...item,expectedSha256:'nope'}]},{planId:PLAN,batch:0,items:Array.from({length:51},(_,i)=>({...item,filmId:'f'+i}))},{planId:PLAN,batch:0,items:[{...item,filmId:'a/b'}]}])
  assert.equal((await post(on,bad)).status,400,JSON.stringify(bad).slice(0,60));
}

// 2. Materialize: every record gets its object and pointer; bodies, order and replacedAt are unchanged; provenance is recorded.
{
 const b=bucket(),on={BUCKET:b,PREDICTION_MATERIALIZATION:'on',PREDICTION_VERSION_OBJECTS:'on'},item=seed(b,'tmdb_7'),before=JSON.parse(b.records.get(bundleKey('tmdb_7')));
 const result=await post(on,{planId:PLAN,batch:0,items:[item]});
 assert.equal(result.status,200);assert.deepEqual(result.data.outcomes,{materialized:1});
 const after=JSON.parse(b.records.get(bundleKey('tmdb_7')));
 assert.equal(rules.predictionMaterializationPlan('tmdb_7',after).pending.length,0);
 for(const [role,record] of [['current',after.current],['history',after.history[0]]]){
  const text=b.records.get(record.r2Key);assert.equal(sha256(text),record.contentSha256,role);
  assert.equal(text,rules.predictionVersionText(role==='current'?before.current:before.history[0]),role+' object holds the old body byte for byte');
 }
 assert.equal(after.history[0].replacedAt,before.history[0].replacedAt);assert.equal(after.current.predictedRating,4);
 assert.deepEqual(after.materialized,{at:after.materialized.at,from:'predictions.json',planId:PLAN,previousEtag:'seed-tmdb_7',previousSha256:item.expectedSha256});
 assert.ok(b.records.has('enrichment/predictions-materialization/'+PLAN+'/0.json'),'a receipt per batch');
 // The same batch again is a replay; the same film in a later batch is recognized as already materialized.
 assert.equal((await post(on,{planId:PLAN,batch:0,items:[item]})).data.replay,true);
 assert.deepEqual((await post(on,{planId:PLAN,batch:1,items:[item]})).data.outcomes,{already_materialized:1});
 // A receipt answers only the exact request it sealed: other items, order, ETag or checksum under the same plan and batch are refused.
 const other=seed(b,'tmdb_8'),receiptsBefore=[...b.records.keys()].length;
 for(const items of [[other],[item,other],[{...item,expectedEtag:'x'}],[{...item,expectedSha256:'b'.repeat(64)}]]){
  for(const dryRun of [false,true]){const refused=await post(on,{planId:PLAN,batch:0,items,dryRun});assert.equal(refused.status,409);assert.equal(refused.data.reason,'receipt_mismatch');}
 }
 assert.equal([...b.records.keys()].length,receiptsBefore,'a refused request writes nothing');
 assert.equal(JSON.parse(b.records.get(bundleKey('tmdb_8'))).current.r2Key,undefined);
 // A later plan from a newer snapshot sees the materialized bundle as it is now: nothing pending, sealed under the new plan.
 const fresh={filmId:'tmdb_7',expectedEtag:b.etags.get(bundleKey('tmdb_7')),expectedSha256:sha256(b.records.get(bundleKey('tmdb_7')))};
 const replanned=await post(on,{planId:'c'.repeat(64),batch:0,items:[fresh]});
 assert.deepEqual(replanned.data.outcomes,{nothing_pending:1});assert.equal(replanned.data.complete,true);
}

// 3. Stop conditions: a changed bundle is skipped, a differing existing object stops the film, a busy writer refuses the batch.
{
 const b=bucket(),on={BUCKET:b,PREDICTION_MATERIALIZATION:'on',PREDICTION_VERSION_OBJECTS:'on'};
 const changed=seed(b,'changed');b.etags.set(bundleKey('changed'),'after-a-submit');
 const mismatch=seed(b,'mismatch'),text=rules.predictionVersionText(legacy('mismatch').current);
 b.records.set(rules.predictionVersionKey('mismatch',sha256(text)),'{"different":true}');
 const present=seed(b,'present'),presentText=rules.predictionVersionText(legacy('present').history[0]);
 b.records.set(rules.predictionVersionKey('present',sha256(presentText)),presentText);
 const result=await post(on,{planId:PLAN,batch:0,items:[changed,mismatch,present]});
 assert.deepEqual(result.data.outcomes,{bundle_changed:1,checksum_mismatch:1,materialized:1});
 assert.equal(result.data.complete,false);assert.deepEqual(result.data.classes,{done:1,replan:1,stop:1});
 assert.ok(!b.records.has('enrichment/predictions-materialization/'+PLAN+'/0.json'),'a mixed batch is never sealed');
 // Re-sending it revisits every film: the finished one is recognized, the two others are reported again, still unsealed.
 const again=await post(on,{planId:PLAN,batch:0,items:[changed,mismatch,present]});
 assert.equal(again.data.replay,false);assert.deepEqual(again.data.outcomes,{already_materialized:1,bundle_changed:1,checksum_mismatch:1});assert.equal(again.data.complete,false);
 assert.equal(result.data.results.find(r=>r.filmId==='present').objectsPresent,1,'an existing identical object is linked, not rewritten');
 assert.equal(JSON.parse(b.records.get(bundleKey('mismatch'))).current.r2Key,undefined,'a mismatch leaves the bundle unchanged');
 b.records.set('enrichment/writer-lease.json',JSON.stringify({id:'submit',expiresAt:Date.now()+60000}));b.etags.set('enrichment/writer-lease.json','lease');
 const busy=await post(on,{planId:PLAN,batch:1,items:[seed(b,'later')]});
 assert.equal(busy.status,409);assert.equal(busy.data.reason,'prediction_writer_busy');
}

// 4. A lost bundle write: the objects are kept, the bundle is untouched, and the retry finishes the film.
{
 const b=bucket(),on={BUCKET:b,PREDICTION_MATERIALIZATION:'on',PREDICTION_VERSION_OBJECTS:'on'},item=seed(b,'lost');
 b.failOnce(key=>key===bundleKey('lost'));
 assert.equal((await post(on,{planId:PLAN,batch:0,items:[item]})).status,502,'the failed batch reports an error and writes no receipt');
 assert.ok(!b.records.has('enrichment/predictions-materialization/'+PLAN+'/0.json'));
 assert.equal(JSON.parse(b.records.get(bundleKey('lost'))).current.r2Key,undefined);
 const retry=await post(on,{planId:PLAN,batch:0,items:[item]});
 assert.deepEqual(retry.data.outcomes,{materialized:1});assert.equal(retry.data.results[0].objectsPresent,2);
}

// 5. The CLI: plan from a snapshot, offline rehearsal on it, tamper refusal, and the remote steps against the Worker.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-prediction-materialize-'));
try{
 const snapshot=path.join(root,'snapshot'),out=path.join(root,'out');fs.mkdirSync(path.join(snapshot,'objects'),{recursive:true});
 const bodies={'watchlist.json':'{"films":[]}'};for(let i=0;i<60;i++)bodies[bundleKey('film'+i)]=JSON.stringify(legacy('film'+i));
 // One bundle the live writer already linked in full (no record pending): the plan leaves it out and the rehearsal must leave it untouched.
 const linked=legacy('linked'),link=record=>{const text=rules.predictionVersionText(record),digest=sha256(text);bodies[rules.predictionVersionKey('linked',digest)]=text;return {...record,r2Key:rules.predictionVersionKey('linked',digest),contentSha256:digest};};
 bodies[bundleKey('linked')]=JSON.stringify({current:link(linked.current),history:[link(linked.history[0])]});
 const entries=Object.entries(bodies).map(([key,text])=>{const name=sha256(key)+'.bin';fs.writeFileSync(path.join(snapshot,'objects',name),text);return {key,file:'objects/'+name,size:Buffer.byteLength(text),sha256:sha256(text),metadata:{key,size:Buffer.byteLength(text),etag:'"etag-'+key.length+'-'+sha256(text).slice(0,8)+'"'}};});
 const manifest={...manifestFor(entries,1,'2026-10-26T00:00:00.000Z','2026-10-26T01:00:00.000Z',[]),status:'consistent_fenced'};
 fs.writeFileSync(path.join(snapshot,'manifest.json'),JSON.stringify(manifest));
 const report=await plan({snapshot,output:out});
 assert.deepEqual(report.planned,{films:60,records:120,batches:2});
 assert.ok(!fs.readFileSync(path.join(out,'report.json'),'utf8').includes('film1'),'the report holds no film id');
 const rehearsal=await rehearse({snapshot,output:out});
 assert.equal(rehearsal.ok,true,JSON.stringify(rehearsal));assert.deepEqual(rehearsal.outcomes,{materialized:60});assert.equal(rehearsal.check.linked,122);
 assert.deepEqual({bundles:rehearsal.check.bundles,planned:rehearsal.check.planned,outsidePlan:rehearsal.check.outsidePlan,outsidePlanChanged:rehearsal.check.outsidePlanChanged,provenance:rehearsal.check.provenance},{bundles:61,planned:60,outsidePlan:1,outsidePlanChanged:0,provenance:60},'provenance is expected on the planned bundles only; the already linked one stays as it was');
 const b=bucket();for(const [key,text] of Object.entries(bodies)){b.records.set(key,text);b.etags.set(key,entries.find(e=>e.key===key).metadata.etag.replace(/"/g,''));}
 const fetchImpl=async(url,init)=>{const response=await ctx.worker.fetch(new Request(url,init),{BUCKET:b,PREDICTION_MATERIALIZATION:'on',PREDICTION_VERSION_OBJECTS:'on'});return {ok:response.ok,status:response.status,json:()=>response.json()};};
 const changedKey=bundleKey('film59'),changedEtag=b.etags.get(changedKey);b.etags.set(changedKey,'after-a-submit');
 const validate=await remote({mode:'validate',output:out,endpoint:'https://site.example',fetchImpl,env:{}});
 assert.deepEqual(validate.totals,{would_materialize:59,bundle_changed:1});assert.deepEqual(validate.incomplete,[{batch:1,classes:{done:9,replan:1,stop:0}}]);assert.equal([...b.records.keys()].filter(key=>key.includes('/versions/')).length,2,'a dry validate writes nothing: only the two objects of the already linked film exist');
 await assert.rejects(remote({mode:'apply',output:out,endpoint:'http://site.example',fetchImpl,env:{}}),/HTTPS/);
 const applied=await remote({mode:'apply',output:out,endpoint:'https://site.example',fetchImpl,env:{}});
 assert.deepEqual(applied.totals,{materialized:59,bundle_changed:1});assert.equal(applied.failed,null);assert.equal(applied.batchesComplete,1);assert.deepEqual(applied.incomplete.map(entry=>entry.batch),[1]);
 assert.ok(b.records.has('enrichment/predictions-materialization/'+JSON.parse(fs.readFileSync(path.join(out,'origin.json'),'utf8')).planId+'/0.json'));
 // Resuming at the incomplete batch revisits it: the finished films are recognized and the changed one is still reported, never sealed.
 const resumed=await remote({mode:'apply',output:out,endpoint:'https://site.example',fromBatch:1,fetchImpl,env:{}});
 assert.deepEqual(resumed.totals,{already_materialized:9,bundle_changed:1});assert.equal(resumed.batchesComplete,0);
 b.etags.set(changedKey,changedEtag);
 const finished=await remote({mode:'apply',output:out,endpoint:'https://site.example',fromBatch:1,fetchImpl,env:{}});
 assert.deepEqual(finished.totals,{already_materialized:9,materialized:1});assert.deepEqual(finished.incomplete,[]);
 const rerun=await remote({mode:'apply',output:out,endpoint:'https://site.example',fetchImpl,env:{}});
 assert.equal(rerun.batchesComplete,2,'a rerun is a replay of both sealed receipts');assert.deepEqual(rerun.totals,{materialized:51,already_materialized:9});
 fs.appendFileSync(path.join(out,'plan.jsonl'),'\n');await assert.rejects(loadPlan(out),/plan.jsonl differs/);
 await assert.rejects(plan({snapshot,output:path.resolve('tests','private-out')}),/outside the Git repository/);
}finally{fs.rmSync(root,{recursive:true,force:true});}
console.log('Prediction version materialization: both gates and strict input, read-only dry run, objects and pointers with unchanged bodies, provenance and receipts, replay bound to the exact items, recognition after a lost response, a later plan, unsealed mixed batches, changed bundle, checksum mismatch, busy writer, CLI plan, offline rehearsal, remote validate/apply/resume with incomplete batches and tamper refusal passed');
