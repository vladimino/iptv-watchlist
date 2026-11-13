// ADR 0132: the optional v2 assessment. Closed-key validation with every issue code, parity of the preflight, the dry run and the real submit, the create-only R2 sidecar and its write order,
// idempotent replay, conflict, fault injection, the crash window and the absence of assessment text from every hot or public projection. Synthetic data only; no model, network or production.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';

const w=await flowWorld({films:6});
assert.equal((await w.api('queue/reconcile',{})).status,200);
vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);
const call=async(name,args)=>{w.ctx.__a={name,args};w.ctx.__env=w.env;const r=await vm.runInContext('mcpCallTool({name:__a.name,arguments:__a.args},"2025-06-18",__env,{waitUntil(){}})',w.ctx);const res=r.result;return {isError:!!res.isError,data:res.structuredContent||null,text:res.content?.[0]?.text||''};};
const metadata={synopsis:'A crew plans a robbery and a detective closes in.',genres:['Crime'],runtime:120,directors:['A Director']};
const SECRET='SYNTHETIC-ASSESSMENT-TEXT';
const base=()=>({assessmentVersion:1,ratingBasis:SECRET+' premise and payoff',probability4PlusBasis:'Good fit, uncertain payoff',
 tasteSignals:[{direction:'supports',signal:'Causal puzzle',anchor:'plot mechanics'},{direction:'against',signal:'Slow third act'}],risks:[{risk:'Mixed payoff',severity:'medium'}],uncertainties:['Reception is mixed'],
 research:{status:'attempted_found',attempts:[{outcome:'blocked',ref:'https://example.com/blocked',note:'paywall'}]},
 sources:[{kind:'metadata',ref:'metadata:synopsis',usedFor:'premise'},{kind:'web_research',ref:'https://example.com/review',usedFor:'reception',access:'full_text'},{kind:'web_research',ref:'https://example.org/other',usedFor:'reception',access:'search_snippet'}],
 conflicts:[{topic:'Ending',positions:[{source:1,stance:'earned'},{source:2,stance:'weak'}],handling:'kept_unresolved'}],model:{status:'reported',id:'synthetic-model',version:'1'}});
const verdict=async(a,pred)=>{const r=await call('prediction_batch_validate',{items:[{filmId:'f1',prediction:pred||w.prediction,assessment:a,metadata}]});assert.equal(r.isError,false,r.text.slice(0,200));return r.data.results[0];};
const issues=async a=>(await verdict(a)).assessment.issues.map(x=>x.path+' '+x.code);
const same=(a,b)=>assert.equal(JSON.stringify(a),JSON.stringify(b));
const mutate=fn=>{const a=base();fn(a);return a;};

// 1. A valid assessment passes; an absent one is not checked; prediction_validate has no assessment verdict.
{
 const ok=await verdict(base());assert.equal(ok.valid,true,JSON.stringify(ok.assessment));same(ok.assessment,{checked:true,issues:[]});
 const none=await call('prediction_batch_validate',{items:[{filmId:'f1',prediction:w.prediction}]});same(none.data.results[0].assessment,{checked:false,issues:[]});assert.equal(none.data.results[0].valid,true);
 const single=await call('prediction_validate',{prediction:w.prediction,assessment:base()});assert.equal(single.isError,true,'prediction_validate refuses an assessment key');
}
// 2. Every rule and issue code, at its path, without echoing a value.
{
 const cases=[
  [mutate(a=>{a.extra=SECRET;}),['assessment.extra unknown_field']],
  [mutate(a=>{delete a.assessmentVersion;}),['assessment.assessmentVersion required']],
  [mutate(a=>{a.assessmentVersion=2;}),['assessment.assessmentVersion invalid_version']],
  [mutate(a=>{a.ratingBasis='';}),['assessment.ratingBasis empty']],
  [mutate(a=>{a.ratingBasis='x'.repeat(701);}),['assessment.ratingBasis too_long']],
  [mutate(a=>{a.probability4PlusBasis=5;}),['assessment.probability4PlusBasis invalid_type']],
  [mutate(a=>{a.tasteSignals=Array.from({length:6},()=>({direction:'supports',signal:'s'}));}),['assessment.tasteSignals too_many']],
  [mutate(a=>{a.tasteSignals=[{direction:'sideways',signal:'s'}];}),['assessment.tasteSignals.direction invalid_enum']],
  [mutate(a=>{a.risks=[{risk:'r',severity:'low'},{risk:'r',severity:'low'},{risk:'r',severity:'low'},{risk:'r',severity:'low'}];}),['assessment.risks too_many']],
  [mutate(a=>{a.uncertainties=['u','u','u','u'];}),['assessment.uncertainties too_many']],
  [mutate(a=>{a.uncertainties=['x'.repeat(221)];}),['assessment.uncertainties too_long']],
  [mutate(a=>{delete a.research;}),['assessment.research required']],
  [mutate(a=>{a.research.status='maybe';}),['assessment.research.status invalid_enum']],
  [mutate(a=>{a.research.attempts=[{outcome:'blocked'},{outcome:'blocked'},{outcome:'blocked'},{outcome:'blocked'},{outcome:'blocked'}];}),['assessment.research.attempts too_many']],
  [mutate(a=>{a.research.attempts=[{outcome:'blocked',ref:'http://example.com/x'}];}),['assessment.research.attempts.ref invalid_ref']],
  [mutate(a=>{a.sources=a.sources.slice(0,1);}),['assessment.sources too_few','assessment.conflicts.positions.source out_of_range','assessment.conflicts.positions.source out_of_range']],
  [mutate(a=>{a.research.status='attempted_blocked';}),['assessment.research.status invalid_enum']],
  [mutate(a=>{a.research={status:'not_attempted',attempts:[{outcome:'blocked'}]};a.sources=[];a.conflicts=[];}),['assessment.research.attempts too_many']],
  [mutate(a=>{a.sources[0].access='full_text';}),['assessment.sources.access invalid_enum']],
  [mutate(a=>{delete a.sources[1].access;}),['assessment.sources.access required']],
  [mutate(a=>{a.sources[1].access='read_it';}),['assessment.sources.access invalid_enum']],
  [mutate(a=>{a.sources[1].ref='http://example.com/x';}),['assessment.sources.ref invalid_ref']],
  [mutate(a=>{a.sources[0].ref='metadata:credits';a.sources[1].ref='https://localhost/x';}),['assessment.sources.ref invalid_ref']],
  [mutate(a=>{a.sources[2]={...a.sources[1]};}),['assessment.sources invalid_ref']],
  [mutate(a=>{a.sources=Array.from({length:7},(_,i)=>({kind:'web_research',ref:'https://example.com/'+i,usedFor:'u',access:'full_text'}));}),['assessment.sources too_many']],
  [mutate(a=>{a.sources[0].usedFor='';}),['assessment.sources.usedFor empty']],
  [mutate(a=>{a.sources[0]={kind:'model_knowledge',ref:'something',usedFor:'u'};}),['assessment.sources.ref invalid_ref']],
  [mutate(a=>{a.conflicts=[a.conflicts[0],a.conflicts[0],a.conflicts[0]];}),['assessment.conflicts too_many']],
  [mutate(a=>{a.conflicts[0].positions=[{source:1,stance:'a'}];}),['assessment.conflicts.positions too_few']],
  [mutate(a=>{a.conflicts[0].positions=[{source:1,stance:'a'},{source:1,stance:'b'}];}),['assessment.conflicts.positions invalid_ref']],
  [mutate(a=>{a.conflicts[0].positions[0].source=9;}),['assessment.conflicts.positions.source out_of_range']],
  [mutate(a=>{a.conflicts[0].positions[0].source='1';}),['assessment.conflicts.positions.source invalid_type']],
  [mutate(a=>{a.conflicts[0].handling='averaged';}),['assessment.conflicts.handling invalid_enum']],
  [mutate(a=>{delete a.model;}),['assessment.model required']],
  [mutate(a=>{a.model={status:'unavailable',id:'x'};}),['assessment.model.id unknown_field']],
  [mutate(a=>{a.model={status:'reported'};}),['assessment.model.id required']],
  [mutate(a=>{a.model={status:'guessed'};}),['assessment.model.status invalid_enum']],
  [mutate(a=>{a.ratingBasis='x'.repeat(700);a.probability4PlusBasis='y'.repeat(400);a.uncertainties=['u'.repeat(220),'u'.repeat(220),'u'.repeat(220)];a.tasteSignals=Array.from({length:5},()=>({direction:'supports',signal:'s'.repeat(220),anchor:'a'.repeat(120)}));}),['assessment too_large']],
 ];
 for(const [a,expected] of cases){const got=await issues(a);assert.equal(JSON.stringify(got),JSON.stringify(expected),JSON.stringify(expected));assert.ok(!JSON.stringify(got).includes(SECRET));}
 // unavailable model and a metadata-free film are explicit and valid; the cap is on serialized UTF-8 bytes, so multibyte text counts by bytes
 assert.equal((await verdict(mutate(a=>{a.model={status:'unavailable'};}))).valid,true);
 const wide=mutate(a=>{a.ratingBasis='ж'.repeat(700);a.probability4PlusBasis='ж'.repeat(400);a.uncertainties=['ж'.repeat(220),'ж'.repeat(220)];a.tasteSignals=[{direction:'supports',signal:'ж'.repeat(220)},{direction:'supports',signal:'ж'.repeat(220)}];a.sources=[];a.conflicts=[];a.research={status:'not_attempted'};});
 assert.ok(new TextEncoder().encode(JSON.stringify(wide)).length>3000);assert.equal(JSON.stringify(await issues(wide)),JSON.stringify(['assessment too_large']));
 // an assessment defect makes the candidate invalid, like a prediction defect; the prediction verdict is independent
 const bad=await verdict(mutate(a=>{a.extra=1;}));assert.equal(bad.valid,false);same(bad.prediction,{checked:true,issues:[]});
}

const ids=async()=>{const r=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled'});assert.equal(r.status,200);return r.data;};
const m=await ids(),[f1,f2,f3,f4,f5]=m.films.map(f=>f.filmId);
const asmKeys=()=>[...w.records.keys()].filter(k=>/\/predictions\/assessments\//.test(k));
const verKeys=()=>[...w.records.keys()].filter(k=>/\/predictions\/versions\//.test(k));
const submit=(items,extra={})=>w.api('batch/submit',{runId:m.runId,epoch:m.lease.epoch,items,...extra});
const item=(id,a)=>({filmId:id,fingerprint:w.fingerprint,prediction:w.prediction,...(a===undefined?{}:{assessment:a})});
const asm=()=>{const a=base();a.sources=a.sources.filter(x=>x.kind!=='metadata');a.sources.forEach(x=>{});a.conflicts[0].positions=[{source:0,stance:'earned'},{source:1,stance:'weak'}];return a;};
const dumpAll=()=>JSON.stringify([...w.records.entries()].filter(([k])=>!/\/predictions\/assessments\//.test(k)))+JSON.stringify(['prediction_pointer','prediction_current','prediction_history','prediction_lineage','prediction_fingerprint'].map(t=>sql(w.file,'SELECT * FROM '+t)));

// 3. A dry run validates the assessment, reports would_write and writes nothing.
{
 const before=JSON.stringify([...w.records.entries()])+JSON.stringify(sql(w.file,"SELECT name FROM sqlite_master"));
 const ok=await submit([item(f1,asm()),item(f2)],{dryRun:true});assert.equal(ok.status,200,JSON.stringify(ok.data).slice(0,300));
 same(ok.data.results.map(r=>[r.filmId,r.status,r.assessment]),[[f1,'would_write','would_write'],[f2,'would_write','not_sent']]);
 const bad=await submit([item(f1,{...asm(),extra:1})],{dryRun:true});assert.equal(bad.data.results[0].status,'validation_failure');assert.equal(bad.data.results[0].validation.stage,'assessment_schema');same(bad.data.results[0].validation.issues,[{path:'assessment.extra',code:'unknown_field'}]);
 assert.equal(JSON.stringify([...w.records.entries()])+JSON.stringify(sql(w.file,"SELECT name FROM sqlite_master")),before,'a dry run writes nothing');assert.equal(asmKeys().length,0);
}
// 4. A real submit writes version, then assessment, then the D1 commit; the object carries confirmed and reported parts apart; no hot projection carries any assessment text.
let firstDigest;
{
 const order=[];const put=w.env.BUCKET.put.bind(w.env.BUCKET);w.env.BUCKET.put=async(k,...r)=>{if(/\/predictions\/(versions|assessments)\//.test(k))order.push(/versions/.test(k)?'version':'assessment');return put(k,...r);};
 const r=await submit([item(f1,asm()),item(f2)]);w.env.BUCKET.put=put;assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));
 same(r.data.results.map(x=>[x.filmId,x.status,x.assessment]),[[f1,'created','written'],[f2,'created','not_sent']]);
 same(order,['version','assessment','version']);assert.equal(asmKeys().length,1);assert.equal(verKeys().length,2);
 const key=asmKeys()[0],obj=JSON.parse(typeof w.records.get(key)==='string'?w.records.get(key):JSON.stringify(w.records.get(key)?.body??w.records.get(key)));
 const body=obj.objectVersion?obj:JSON.parse(obj);assert.equal(body.objectVersion,1);assert.equal(body.filmId,f1);
 assert.ok(key.endsWith('/'+body.predictionSha256+'.json'));assert.ok(body.predictionKey.endsWith('/predictions/versions/'+body.predictionSha256+'.json'));assert.ok(w.records.has(body.predictionKey));
 assert.deepEqual(Object.keys(body.confirmed).sort(),['assessmentSha256','fingerprintHash','predictionGeneratedAt','recordedAt','runId','tasteProfile','trigger']);
 assert.deepEqual(Object.keys(body.callerReported).sort(),['conflicts','model','research','sources']);assert.deepEqual(Object.keys(body.assessment).sort(),['assessmentVersion','probability4PlusBasis','ratingBasis','risks','tasteSignals','uncertainties']);
 assert.equal(body.callerReported.model.id,'synthetic-model');assert.equal(body.confirmed.runId,m.runId);
 console.log('sidecar object: '+new TextEncoder().encode(JSON.stringify(body)).length+' B for a caller assessment of '+new TextEncoder().encode(JSON.stringify(asm())).length+' B');
 assert.ok(!dumpAll().includes(SECRET),'no assessment text in D1, the bundle, the view index, Events or any other object');
 assert.ok(!w.logs.join('\n').includes(SECRET),'no assessment text in any log line');
 firstDigest=JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+m.runId+"'")[0].d).submitted;
 assert.notEqual(firstDigest[f1].inputDigest,firstDigest[f2].inputDigest);assert.equal(firstDigest[f1].assessment,'written');assert.equal(firstDigest[f2].assessment,'not_sent');
}
// 5. Replay of the same body is idempotent; a different assessment is a conflict and overwrites nothing; a film without one is unaffected.
{
 const before=asmKeys().map(k=>JSON.stringify(w.records.get(k)));
 const r=await submit([item(f1,asm()),item(f2)]);same(r.data.results.map(x=>[x.filmId,x.status,x.assessment,x.replayed]),[[f1,'created','present',true],[f2,'created','not_sent',true]]);
 const c=await submit([item(f1,{...asm(),ratingBasis:'another'})]);assert.equal(c.data.results[0].status,'conflict');
 const d=await submit([item(f2,asm())]);assert.equal(d.data.results[0].status,'conflict','an assessment added to a settled film is a different payload');
 same(asmKeys().map(k=>JSON.stringify(w.records.get(k))),before);
}
// 6. Fault before the object write: the film is a storage_error stop, nothing is committed, the same body replays and completes.
{
 const put=w.env.BUCKET.put.bind(w.env.BUCKET);let armed=true;w.env.BUCKET.put=async(k,...r)=>{if(armed&&/\/assessments\//.test(k)){armed=false;throw new Error('r2 down');}return put(k,...r);};
 const r=await submit([item(f3,asm())]);w.env.BUCKET.put=put;
 assert.equal(r.data.results[0].status,'blocked');assert.equal(r.data.results[0].reason,'storage_error');
 assert.equal(sql(w.file,"SELECT film_id FROM prediction_pointer WHERE film_id='"+f3+"'").length,0,'no D1 pointer before the object exists');
 assert.equal(asmKeys().filter(k=>k.includes('/'+f3+'/')).length,0);assert.equal(verKeys().filter(k=>k.includes('/'+f3+'/')).length,1,'an unreferenced version object may remain');
 const again=await submit([item(f3,asm())]);assert.equal(again.status,200,JSON.stringify(again.data).slice(0,300));same(again.data.results.map(x=>[x.status,x.assessment]),[['created','written']]);
 assert.equal(sql(w.file,"SELECT film_id FROM prediction_pointer WHERE film_id='"+f3+"'").length,1);
}
// 7. Crash window: the commit happened but the run record did not keep the result. The replay writes a missing object and answers; a different content is a conflict.
{
 const row=()=>JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+m.runId+"'")[0].d);
 const forget=id=>{const doc=row();delete doc.submitted[id];delete doc.results[id];sql(w.file,"UPDATE prediction_run SET document_json='"+JSON.stringify(doc).replace(/'/g,"''")+"' WHERE run_id='"+m.runId+"'");};
 const key=asmKeys().find(k=>k.includes('/'+f3+'/'));assert.ok(key);const saved=w.records.get(key);w.records.delete(key);forget(f3);
 const r=await submit([item(f3,asm())]);assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));same(r.data.results.map(x=>[x.status,x.replayed,x.assessment]),[['created',true,'written']]);assert.ok(w.records.has(key),'the missing object was written');
 forget(f3);const c=await submit([item(f3,{...asm(),ratingBasis:'different'})]);assert.equal(c.data.results[0].status,'conflict');
 w.records.set(key,saved);
}
// 8. An invalid assessment fails only its film at the assessment_schema stage: nothing is stored for it, the others are unaffected; a failure item is not_applicable.
{
 const r=await submit([item(f4,{...asm(),extra:1}),item(f5),{filmId:m.films[5]?.filmId||f5,failure:{kind:'parse_error'},assessment:asm()}].slice(0,2));
 same(r.data.results.map(x=>[x.filmId,x.status,x.assessment]),[[f4,'validation_failure','not_applicable'],[f5,'created','not_sent']]);
 same(r.data.results[0].validation,{stage:'assessment_schema',reportedBy:'worker',issues:[{path:'assessment.extra',code:'unknown_field'}]});
 assert.equal(sql(w.file,"SELECT film_id FROM prediction_pointer WHERE film_id='"+f4+"'").length,0);assert.equal(asmKeys().filter(k=>k.includes('/'+f4+'/')).length,0);
}
// 9. The published contract and the v5 route: enrichment_schema carries contract.assessment; the v5 submit refuses the key.
{
 const schema=await call('enrichment_schema',{});const a=schema.data?.contract?.assessment||JSON.parse(schema.text).contract.assessment;
 assert.equal(a.version,1);assert.equal(a.required,false);assert.equal(a.maxSerializedBytes,3000);assert.ok(a.consistency.includes('attempted_found'));
 assert.ok((schema.data?.contract||JSON.parse(schema.text).contract).issueCodes.includes('unknown_field'));
 const v5=await w.api('submit',{runId:'none',items:[{filmId:f1,prediction:w.prediction,assessment:asm()}]});assert.equal(v5.status,400);same(v5.data.issues,[{path:'items[0].assessment',code:'unknown_field'}]);
 const mcp=await call('prediction_submit',{runId:m.runId,items:[{filmId:f1,prediction:w.prediction,assessment:asm()}]});assert.equal(mcp.isError,true);
}
// 10. The group limit: ten films with a full-size assessment exceed the 56 KiB request bound and are refused whole with nothing checked; the same films in two groups of five pass. Generation size and call size are independent.
{
 const LIMIT=56*1024,enc=x=>new TextEncoder().encode(JSON.stringify(x)).length;
 const full=()=>({assessmentVersion:1,ratingBasis:'r'.repeat(700),probability4PlusBasis:'p'.repeat(400),tasteSignals:Array.from({length:5},(_,i)=>({direction:'supports',signal:'s'.repeat(215)+i})),risks:[{risk:'k'.repeat(100),severity:'low'}],uncertainties:['u'.repeat(100)],research:{status:'not_attempted'},sources:[{kind:'model_knowledge',ref:'model_knowledge',usedFor:'u'.repeat(60)}],conflicts:[],model:{status:'reported',id:'synthetic-model'}});
 const bytes=enc(full());assert.ok(bytes<=3000&&bytes>2900,'the test assessment is near the cap: '+bytes);
 const fat=()=>({...w.fingerprint,strengths:Array.from({length:6},(_,i)=>'a'.repeat(400)+i),risks:Array.from({length:6},(_,i)=>'b'.repeat(400)+i)});
 const items=n=>Array.from({length:n},(_,i)=>({filmId:'g'+i,fingerprint:fat(),prediction:w.prediction,assessment:full()}));
 const ten=items(10),tenBytes=enc({items:ten});assert.ok(tenBytes>LIMIT,'ten films with assessments are over the bound: '+tenBytes);
 const refused=await call('prediction_batch_validate',{items:ten});assert.equal(refused.isError,true);assert.ok(/byte limit/.test(refused.text));
 const five=items(5),fiveBytes=enc({items:five});assert.ok(fiveBytes<LIMIT,'five fit: '+fiveBytes);
 const ok=await call('prediction_batch_validate',{items:five});assert.equal(ok.isError,false,ok.text.slice(0,200));assert.equal(ok.data.counts.valid,5);
 console.log('group bounds: assessment '+bytes+' B, ten films '+tenBytes+' B (refused), five films '+fiveBytes+' B (accepted)');
}
console.log('prediction-assessment: closed validation with every code, dry run and preflight parity, create-only sidecar and its order, replay, conflict, fault, crash window and privacy passed');
