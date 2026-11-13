// AIR-450: prediction_batch_validate, the read-only preflight of 1 to 10 candidates of a batch runner v2 group, on the real MCP handler and the real Worker validators (no model, no network, no production).
// It must give exactly the verdicts prediction_validate and the dry-run of prediction_batch_submit give, bind every result to the index and filmId sent, never let one item fail the others, touch no storage,
// and stay light: the measured latency and sizes are printed for the evidence page.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const dump=f=>{const r=sqliteSync([f,'.dump'],{encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);return r.stdout;};
const snapshot=w=>JSON.stringify([[...w.records.entries()],dump(w.file)]);
const enc=s=>new TextEncoder().encode(s).length;
const w=await flowWorld({films:14});
// the films carry the metadata the candidates cite, as a real manifest's modelMetadata does
sql(w.file,"UPDATE discovery_admission SET payload_json=json_set(payload_json,'$.synopsis','A crew plans a robbery and a detective closes in.','$.genres',json('[\"Crime\",\"Thriller\"]'),'$.runtime',120,'$.directors',json('[\"A Director\"]'),'$.actors',json('[\"An Actor\"]'))");
assert.equal((await w.api('queue/reconcile',{})).status,200);
vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);
const call=async(name,args,env=w.env)=>{w.ctx.__a={name,args};w.ctx.__env=env;const r=await vm.runInContext('mcpCallTool({name:__a.name,arguments:__a.args},"2025-06-18",__env,{waitUntil(){}})',w.ctx);const res=r.result;return {isError:!!res.isError,text:res.content[0].text,data:res.isError?null:JSON.parse(res.content[0].text),structured:res.structuredContent};};
const plain=v=>JSON.parse(JSON.stringify(v));
const EXECUTION=plain(vm.runInContext('EXECUTION',w.ctx)),GENERAL=plain(vm.runInContext('GENERAL_EXECUTION',w.ctx));
const item=(basis,refs,confidence='medium')=>({basis,refs,confidence});
const metadata={synopsis:'A crew plans a robbery and a detective closes in.',genres:['Crime','Thriller'],runtime:120,directors:['A Director'],actors:['An Actor']};
const baseFp={fingerprintSchemaVersion:1,plotMechanics:['heist','investigation'],moodLabels:['мрачный','напряжённый'],strengths:['A causal puzzle'],risks:['Mixed payoff'],confidence:'medium'};
const unknownExec=Object.fromEntries(Object.entries(EXECUTION).map(([k,v])=>[k,v.includes('unknown')?'unknown':v[0]]));
const prediction=(over={})=>({predictedRating:3.5,probability4Plus:.45,confidence:'medium',matchSignals:['Investigation'],mainRisk:'Mixed payoff',moodLabels:['мрачный','напряжённый'],...over});
// a realistic fingerprint: every general dimension concrete, each with model_knowledge and web_research evidence, mechanics with metadata and model knowledge; the source fields are omitted (ADR 0129)
const rich=(n)=>{
 const execution={...unknownExec},evidence={plotMechanics:{heist:[item('metadata',['metadata:synopsis','metadata:genres']),item('model_knowledge',['model_knowledge'])],investigation:[item('model_knowledge',['model_knowledge']),item('web_research',['https://example.com/film/'+n+'/investigation'])]},execution:{}};
 for(const k of GENERAL){const v=EXECUTION[k].find(x=>x!=='unknown'&&x!=='not_applicable');if(v){execution[k]=v;evidence.execution[k]=[item('model_knowledge',['model_knowledge'],'high'),item('web_research',['https://example.com/film/'+n+'/'+k],'medium')];}}
 return {...baseFp,execution,evidence,strengths:['Film-specific strength '+n+': '+'x'.repeat(120)],risks:['Film-specific risk '+n+': '+'y'.repeat(120)]};
};
const stakesMetaOnly=()=>({...baseFp,execution:{...unknownExec,stakes:EXECUTION.stakes.find(x=>x!=='unknown'&&x!=='not_applicable')},evidence:{plotMechanics:{heist:[item('metadata',['metadata:synopsis'])],investigation:[item('model_knowledge',['model_knowledge'])]},execution:{stakes:[item('metadata',['metadata:synopsis'])]}}});
const codes=r=>r.fingerprint.issues.concat(r.prediction.issues).map(x=>x.path+' '+x.code);
const ids=n=>Array.from({length:n},(_,i)=>'tmdb_'+(i+1));

// 1. A valid group of ten (full-fingerprint films with metadata, model_knowledge and web_research claims and the source fields omitted, and prediction_only films with only a prediction).
{
 const items=ids(10).map((id,i)=>i<6?{filmId:id,fingerprint:rich(i),prediction:prediction({predictedRating:2+(i%5)/2}),metadata}:{filmId:id,prediction:prediction()});
 const r=await call('prediction_batch_validate',{items});assert.equal(r.isError,false,r.text.slice(0,300));
 const d=r.data;assert.equal(d.success,true);assert.equal(d.valid,true);assert.equal(d.contractVersion,1);assert.deepEqual(d.counts,{items:10,valid:10,invalid:0});assert.equal(d.storage,'not_accessed');assert.equal(d.sideEffects,'none');
 assert.deepEqual(d.results.map(x=>[x.index,x.filmId,x.valid]),items.map((it,i)=>[i,it.filmId,true]),'bound to index and filmId, in request order');
 assert.deepEqual(d.results.map(x=>x.fingerprint.checked),[true,true,true,true,true,true,false,false,false,false]);assert.ok(d.results.every(x=>x.prediction.checked&&x.itemIssues.length===0));
 assert.deepEqual(plain(r.structured),d,'text and structuredContent agree');
}

// 2. Nine films whose only execution-quality evidence is metadata (the C6 shape): each reports exactly the stakes issue, the tenth is valid; nothing is derived or invented for them.
{
 const items=ids(10).map((id,i)=>i<9?{filmId:id,fingerprint:stakesMetaOnly(),prediction:prediction(),metadata}:{filmId:id,fingerprint:rich(9),prediction:prediction(),metadata});
 const d=(await call('prediction_batch_validate',{items})).data;
 assert.equal(d.success,false);assert.deepEqual(d.counts,{items:10,valid:1,invalid:9});
 for(let i=0;i<9;i++){assert.deepEqual(d.results[i].fingerprint.issues,[{path:'fingerprint.evidence.execution.stakes',code:'invalid_ref'}],'film '+i);assert.equal(d.results[i].valid,false);assert.deepEqual(d.results[i].prediction.issues,[]);}
 assert.equal(d.results[9].valid,true);
}

// 3. Partial and empty evidence, source fields omitted against supplied (ADR 0129), invalid enums, a bad prediction, a prediction_only film that also carries a fingerprint: each item on its own.
{
 const cases=[
  ['asserted mechanic without items',{...baseFp,execution:{...unknownExec},evidence:{plotMechanics:{heist:[item('model_knowledge',['model_knowledge'])]}}}],
  ['empty evidence map',{...baseFp,plotMechanics:[],execution:{...unknownExec},evidence:{}}],
  ['null evidence',{...baseFp,execution:{...unknownExec},evidence:null}],
  ['both fields supplied, wrong refs',{...rich(0),sourceBasis:'mixed',sourceRefs:[]}],
  ['one field supplied wrong, one omitted',{...rich(0),sourceBasis:'bogus'}],
  ['invalid enum',{...rich(0),execution:{...rich(0).execution,payoff:'medium'}}],
  ['fingerprint of a legacy shape without evidence and without source fields',{...baseFp,execution:{...unknownExec}}],
 ];
 const items=cases.map(([,fp],i)=>({filmId:'tmdb_'+(i+1),fingerprint:fp,prediction:prediction(),metadata}));
 items.push({filmId:'tmdb_8',prediction:prediction({predictedRating:9})},{filmId:'tmdb_9',fingerprint:rich(1),prediction:prediction(),metadata},{filmId:'tmdb_10',fingerprint:rich(2),metadata});
 const d=(await call('prediction_batch_validate',{items})).data;
 const got=d.results.map(codes);
 assert.deepEqual(got[0],['fingerprint.evidence.plotMechanics.investigation required']);
 assert.deepEqual(got[1],['fingerprint.evidence too_few']);
 assert.deepEqual(got[2],['fingerprint.evidence invalid_type'],'only its own issue');
 assert.deepEqual(got[3],['fingerprint.sourceRefs invalid_ref'],'a supplied wrong aggregate is not corrected');
 assert.ok(got[4].includes('fingerprint.sourceBasis invalid_enum')&&!got[4].includes('fingerprint.sourceRefs required'));
 assert.deepEqual(got[5],['fingerprint.execution.payoff invalid_enum','fingerprint.evidence.execution.payoff invalid_enum'],'the value and the claim that rests on it');
 assert.ok(got[6].includes('fingerprint.sourceBasis required'),'without evidence the legacy rule still needs the source fields');
 assert.deepEqual(got[7],['prediction.predictedRating out_of_range']);
 assert.deepEqual(got[8],[],'a valid film among invalid ones');assert.equal(d.results[8].valid,true);
 assert.deepEqual(d.results[9].prediction,{checked:false,issues:[]});assert.equal(d.results[9].valid,true,'a fingerprint alone is checked as such');
 assert.equal(d.counts.valid,2);assert.equal(d.success,false);
}

// 4. A defect of one item is its own result and never fails the others; the request still answers. No value is echoed.
{
 const SECRET='SECRETVALUE';
 const items=[{filmId:'tmdb_1',prediction:prediction()},'text',{prediction:prediction()},{filmId:'bad id!',prediction:prediction()},{filmId:'tmdb_5',prediction:prediction(),extra:SECRET},{filmId:'tmdb_6',fingerprint:'text',prediction:prediction()},{filmId:'tmdb_7'},{filmId:'tmdb_8',prediction:[],metadata:SECRET}];
 const r=await call('prediction_batch_validate',{items});assert.equal(r.isError,false,r.text.slice(0,200));
 const d=r.data,at=i=>d.results[i];
 assert.equal(at(0).valid,true);
 assert.deepEqual(at(1).itemIssues,[{path:'item',code:'invalid_type'}]);
 assert.deepEqual(at(2).itemIssues,[{path:'item.filmId',code:'required'}]);
 assert.deepEqual(at(3).itemIssues,[{path:'item.filmId',code:'invalid_type'}]);assert.equal(at(3).filmId,null);
 assert.deepEqual(at(4).itemIssues,[{path:'item.extra',code:'unknown_field'}],'an undeclared key is named with the submit code; its value is never echoed');
 assert.deepEqual(at(5).itemIssues,[{path:'item.fingerprint',code:'invalid_type'}]);
 assert.deepEqual(at(6).itemIssues,[{path:'item',code:'required'}]);
 assert.deepEqual(at(7).itemIssues.map(x=>x.path).sort(),['item.metadata','item.prediction']);
 assert.ok(!r.text.includes(SECRET),'no value of a defective item is echoed');assert.deepEqual(d.counts,{items:8,valid:1,invalid:7});assert.equal(d.success,false);
 assert.deepEqual(d.results.map(x=>x.index),[0,1,2,3,4,5,6,7]);
}

// 5. The request is refused whole, before any item is looked at, and says why.
{
 const bad=async(args)=>{const r=await call('prediction_batch_validate',args);assert.equal(r.isError,true,JSON.stringify(args).slice(0,80));return r.text;};
 await bad({});await bad({items:'x'});await bad({items:[]});await bad({items:ids(11).map(id=>({filmId:id,prediction:prediction()}))});
 await bad({items:[{filmId:'tmdb_1',prediction:prediction()}],key:'enrichment/x'});
 assert.match(await bad({items:[{filmId:'tmdb_1',prediction:prediction()},{filmId:'tmdb_1',prediction:prediction()}]}),/Each filmId may appear once/);
 // an oversized request: ten fingerprints at the 12,000-character maximum are well over 56 KiB: nothing is checked and the answer says to split
 const fat=n=>({...rich(n),strengths:Array.from({length:8},(_,i)=>'s'+i+'z'.repeat(480)),risks:Array.from({length:8},(_,i)=>'r'+i+'q'.repeat(480))});
 const text=await bad({items:ids(10).map((id,i)=>({filmId:id,fingerprint:fat(i),prediction:prediction(),metadata}))});
 assert.match(text,/over the 57344 byte limit/);assert.match(text,/split the group/);assert.ok(text.length<400,'the refusal does not echo the payload');
}

// 6. Parity with prediction_validate and with the dry run of prediction_batch_submit, on the same candidates.
{
 const manifest=(await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',dryRun:true})).data;
 const film=manifest.films.slice(0,10).map(f=>f.filmId);
 const variants=[rich(0),stakesMetaOnly(),{...rich(1),sourceBasis:'mixed',sourceRefs:[]},{...rich(2),execution:{...rich(2).execution,payoff:'medium'}},{...baseFp,execution:{...unknownExec},evidence:null},{...rich(3),evidence:{plotMechanics:rich(3).evidence.plotMechanics}},rich(4),{...baseFp,execution:{...unknownExec},evidence:{}},{...rich(5),moodLabels:['one']},rich(6)];
 const preds=[prediction(),prediction(),prediction({probability4Plus:2}),prediction(),prediction(),prediction({confidence:'sure'}),prediction(),prediction(),prediction(),prediction({matchSignals:[]})];
 const items=film.map((id,i)=>({filmId:id,fingerprint:variants[i],prediction:preds[i],metadata:manifest.films[i].modelMetadata}));
 const batch=(await call('prediction_batch_validate',{items})).data;
 for(const [i,it] of items.entries()){
  const single=(await call('prediction_validate',{fingerprint:it.fingerprint,prediction:it.prediction,metadata:it.metadata})).data;
  assert.deepEqual(batch.results[i].fingerprint,single.fingerprint,'fingerprint parity with prediction_validate, item '+i);assert.deepEqual(batch.results[i].prediction,single.prediction,'prediction parity, item '+i);assert.equal(batch.results[i].valid,single.valid);
 }
 // the dry run answers per film at the first failing stage with the same issues, and would_write exactly when the preflight is valid
 const dry=(await w.api('batch/submit',{runId:'dry-run',epoch:1,dryRun:true,manifestHash:manifest.manifestHash,items:items.map((it,i)=>({filmId:it.filmId,fingerprint:it.fingerprint,prediction:it.prediction,inputHash:manifest.films[i].inputHash}))})).data;
 for(const [i,res] of dry.results.entries()){
  const b=batch.results[i];
  if(b.valid){assert.equal(res.status,'would_write','a candidate that passes the preflight is not refused for its content at submit, item '+i);}
  else{assert.equal(res.status,'validation_failure','item '+i);const expected=b.fingerprint.issues.length?b.fingerprint.issues:b.prediction.issues;assert.deepEqual(res.validation.issues,expected,'the submit issues are the preflight issues of the first failing object, item '+i);}
 }
 assert.ok(batch.counts.valid>=3&&batch.counts.invalid>=5,'the parity set mixes valid and invalid candidates: '+JSON.stringify(batch.counts));
}

// 7. Read-only: it answers without any storage binding, and on a live world every R2 and D1 call is a fault and the whole state is unchanged.
{
 const bare=await call('prediction_batch_validate',{items:[{filmId:'tmdb_1',prediction:prediction()}]},{});assert.equal(bare.isError,false,'handled before the storage check: it needs no bucket');
 const before=snapshot(w),faults=[],fail=what=>{faults.push(what);throw new Error('STORAGE_FAULT '+what);};
 const guard=new Proxy({},{get:(_,k)=>(...a)=>fail(String(k))});
 const r=await call('prediction_batch_validate',{items:ids(10).map((id,i)=>({filmId:id,fingerprint:rich(i),prediction:prediction(),metadata}))},{BUCKET:guard,DB:guard});
 assert.equal(r.isError,false);assert.equal(r.data.valid,true);assert.deepEqual(faults,[],'no storage call of any kind');
 const ok=await call('prediction_batch_validate',{items:ids(10).map((id,i)=>({filmId:id,fingerprint:rich(i),prediction:prediction(),metadata}))});assert.equal(snapshot(w),before,'D1 dump and every R2 object unchanged');assert.equal(ok.data.valid,true);
}

// 8. Cost: ten realistic candidates, repeated. Light CPU only (no storage, no network); the numbers feed the evidence page.
{
 const items=ids(10).map((id,i)=>({filmId:id,fingerprint:rich(i),prediction:prediction(),metadata})),req=enc(JSON.stringify({items}));
 assert.ok(req<57344,'ten realistic candidates fit one request: '+req);
 const times=[];let last;for(let n=0;n<200;n++){const t=process.hrtime.bigint();last=await call('prediction_batch_validate',{items});times.push(Number(process.hrtime.bigint()-t)/1e6);}
 times.sort((a,b)=>a-b);const median=times[100],p95=times[190];
 assert.equal(last.data.valid,true);const resp=enc(last.text);
 assert.ok(p95<100,'a preflight of ten candidates is a light validation, not a long operation: p95 '+p95.toFixed(2)+' ms');
 console.log('batch preflight, 10 realistic candidates: request '+req+' bytes, response '+resp+' bytes, structuredContent twin '+enc(JSON.stringify(last.structured))+' bytes, median '+median.toFixed(2)+' ms, p95 '+p95.toFixed(2)+' ms over 200 calls (local, in-process, not production)');
}
console.log('prediction-batch-validate ok');
