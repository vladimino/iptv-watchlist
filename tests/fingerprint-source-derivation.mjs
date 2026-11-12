// ADR 0129: the Worker derives fingerprint.sourceBasis and fingerprint.sourceRefs from a valid evidence map when the caller omitted BOTH, and never rewrites a value the caller supplied.
// The derivation is checked against an independent reference written from the documented rule (walk order, first-seen unique, cap 8, one basis or mixed), over fixed cases (the C3 failure
// of AIR-450 among them) and a seeded random sweep, against the real validator of the Worker (no model, no network, no production).
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
for(const file of ['src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-versions.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker=').replace(/^export (async )?function/gm,'$1function').replace(/^export const /gm,'const ').replace(/^export \{[^}]*\};?$/gm,''),ctx);
const call=code=>vm.runInContext(code,ctx),plain=value=>JSON.parse(JSON.stringify(value));
const deriveRaw=(f,m)=>call('deriveFingerprintSource')(f,m),derive=(f,m)=>plain(deriveRaw(f,m));
const issues=(f,m)=>plain(call('fingerprintIssues')(f,m)).map(x=>x.path+' '+x.code);
const EXECUTION=plain(call('EXECUTION')),GENERAL=plain(call('GENERAL_EXECUTION')),GENRE=plain(call('GENRE_EXECUTION')),MECHANICS=plain(call('MECHANICS'));
const concrete=Object.fromEntries(Object.entries(EXECUTION).map(([k,v])=>[k,v.includes('unknown')?'unknown':v[0]]));
const metadata={synopsis:'A crew plans a robbery.',genres:['Crime'],runtime:170,directors:['Michael Mann'],actors:['Al Pacino']};
const item=(basis,refs,confidence='medium')=>({basis,refs,confidence});
const base={fingerprintSchemaVersion:1,plotMechanics:['heist','investigation'],execution:{...concrete},moodLabels:['мрачный','напряжённый'],strengths:['A causal puzzle'],risks:['Mixed payoff'],confidence:'medium'};
const fp=(over={})=>{const f={...base,...over,execution:{...concrete,...(over.execution||{})}};return f;};

// Reference: the documented rule, written here independently of the Worker's code.
function reference(f){
 const claims=[];
 for(const m of f.plotMechanics)claims.push(f.evidence.plotMechanics?.[m]||[]);
 for(const k of [...GENERAL,...GENRE])if(f.evidence.execution&&Object.hasOwn(f.evidence.execution,k))claims.push(f.evidence.execution[k]);
 const bases=[],refs=[];
 for(const c of claims)for(const it of c){if(!bases.includes(it.basis))bases.push(it.basis);for(const r of it.refs)if(!refs.includes(r)&&refs.length<8)refs.push(r);}
 return {sourceBasis:bases.length===1?bases[0]:'mixed',sourceRefs:refs};
}

// 1. The AIR-450 C3 failure. Evidence with a metadata-only mechanic and the legacy habit of an empty sourceRefs is rejected when supplied, and accepted when omitted (derived).
{
 const evidence={plotMechanics:{heist:[item('metadata',['metadata:synopsis'])],investigation:[item('metadata',['metadata:genres'])]}};
 const supplied=fp({evidence,sourceBasis:'metadata',sourceRefs:[]});
 assert.deepEqual(issues(supplied,metadata),['fingerprint.sourceRefs invalid_ref'],'a supplied empty list is still rejected, never rewritten');
 const omitted=fp({evidence});
 const d=derive(omitted,metadata);
 assert.equal(d.sourceBasis,'metadata');assert.deepEqual(d.sourceRefs,['metadata:synopsis','metadata:genres']);
 assert.deepEqual(issues(d,metadata),[],'the derived fingerprint passes the real validator');
 assert.equal(Object.hasOwn(omitted,'sourceBasis'),false,'the input object is not changed');
 // the same fingerprint spelled out by the caller is identical to the derived one
 assert.deepEqual(d,fp({evidence,sourceBasis:'metadata',sourceRefs:['metadata:synopsis','metadata:genres']}));
}

// 2. Order, de-duplication, cap of 8 and mixed: mechanics in the declared order, then the 13 general dimensions, then genre dimensions in schema order.
{
 const evidence={
  plotMechanics:{investigation:[item('web_research',['https://example.com/i'])],heist:[item('metadata',['metadata:synopsis','metadata:genres'])]},
  execution:{payoff:[item('model_knowledge',['model_knowledge'])],pace:[item('web_research',['https://example.com/i','https://example.com/p'])]},
 };
 const f=fp({plotMechanics:['investigation','heist'],execution:{payoff:'strong',pace:'fast'},evidence});
 const d=derive(f,metadata);
 // GENERAL order puts plot_engine, pace, ..., payoff: pace before payoff, whatever the object key order
 assert.deepEqual(d.sourceRefs,['https://example.com/i','metadata:synopsis','metadata:genres','https://example.com/p','model_knowledge']);
 assert.equal(d.sourceBasis,'mixed');assert.deepEqual(issues(d,metadata),[]);assert.deepEqual({sourceBasis:d.sourceBasis,sourceRefs:d.sourceRefs},reference(f));
 // one basis keeps its name
 const single=fp({plotMechanics:['heist'],evidence:{plotMechanics:{heist:[item('model_knowledge',['model_knowledge'])]}}});
 assert.equal(derive(single,metadata).sourceBasis,'model_knowledge');
 // a cap of 8: 16 distinct URLs over four claims keep the first eight
 const urls=Array.from({length:16},(_,i)=>'https://example.com/c/'+i);
 const many=fp({plotMechanics:[],execution:{pace:'fast',stakes:'high',plot_engine:'strong',chemistry:'strong'},evidence:{execution:{plot_engine:[item('web_research',urls.slice(0,4))],pace:[item('web_research',urls.slice(4,8))],stakes:[item('web_research',urls.slice(8,12))],chemistry:[item('web_research',urls.slice(12,16))]}}});
 const dm=derive(many,metadata);assert.deepEqual(dm.sourceRefs,urls.slice(0,8));assert.deepEqual(issues(dm,metadata),[]);
}

// 3. A supplied value is never rewritten, and one omitted value is not derived: each stays a rejection.
{
 const evidence={plotMechanics:{heist:[item('metadata',['metadata:synopsis'])],investigation:[item('metadata',['metadata:genres'])]}};
 const wrong=fp({evidence,sourceBasis:'mixed',sourceRefs:['metadata:synopsis','metadata:genres']});
 assert.equal(deriveRaw(wrong,metadata),wrong,'both supplied: returned as is');assert.deepEqual(issues(wrong,metadata),['fingerprint.sourceBasis invalid_enum']);
 const onlyBasis=fp({evidence,sourceBasis:'metadata'});assert.equal(deriveRaw(onlyBasis,metadata),onlyBasis);assert.ok(issues(onlyBasis,metadata).length);
 const onlyRefs=fp({evidence,sourceRefs:['metadata:synopsis','metadata:genres']});assert.equal(deriveRaw(onlyRefs,metadata),onlyRefs);assert.ok(issues(onlyRefs,metadata).length);
 // no evidence: nothing to derive from, the legacy rule is unchanged (the fields stay required)
 const none=fp({});assert.equal(deriveRaw(none,metadata),none);assert.ok(issues(none,metadata).some(x=>x==='fingerprint.sourceBasis required'));
}

// 4. An invalid evidence map derives nothing, and the omitted fields are not reported as missing on top of the real cause.
{
 const cases={
  'asserted mechanic without items':{plotMechanics:{heist:[item('metadata',['metadata:synopsis'])]}},
  'metadata ref whose fact is absent':{plotMechanics:{heist:[item('metadata',['metadata:runtime'])],investigation:[item('metadata',['metadata:poster'])]}},
  'forbidden url':{plotMechanics:{heist:[item('web_research',['http://example.com/a'])],investigation:[item('model_knowledge',['model_knowledge'])]}},
  'internal host':{plotMechanics:{heist:[item('web_research',['https://127.0.0.1/a'])],investigation:[item('model_knowledge',['model_knowledge'])]}},
  'model_knowledge with a url':{plotMechanics:{heist:[item('model_knowledge',['https://example.com/a'])],investigation:[item('model_knowledge',['model_knowledge'])]}},
  'duplicate item':{plotMechanics:{heist:[item('metadata',['metadata:synopsis']),item('metadata',['metadata:synopsis'])],investigation:[item('metadata',['metadata:genres'])]}},
  'extra key':{plotMechanics:{heist:[{...item('metadata',['metadata:synopsis']),quote:'x'}],investigation:[item('metadata',['metadata:genres'])]}},
  'unknown dimension with items':{plotMechanics:{heist:[item('metadata',['metadata:synopsis'])],investigation:[item('metadata',['metadata:genres'])]},execution:{made_up:[item('model_knowledge',['model_knowledge'])]}},
 };
 const metaEvidence=(execution)=>({plotMechanics:{heist:[item('metadata',['metadata:synopsis'])],investigation:[item('metadata',['metadata:genres'])]},execution});
 for(const [label,evidence] of Object.entries(cases)){
  const f=fp({evidence}),d=derive(f,metadata);
  assert.equal(Object.hasOwn(d,'sourceBasis'),false,label+': nothing derived');
  const found=issues(d,metadata);assert.ok(found.length,label+': rejected');assert.ok(!found.includes('fingerprint.sourceBasis required')&&!found.includes('fingerprint.sourceRefs required'),label+': the cause is the evidence, not the omitted fields ('+found+')');
 }
 // a metadata-only execution-quality claim is not evidence of quality
 const quality=fp({execution:{payoff:'strong'},evidence:metaEvidence({payoff:[item('metadata',['metadata:synopsis'])]})});
 assert.equal(Object.hasOwn(derive(quality,metadata),'sourceBasis'),false);assert.ok(issues(derive(quality,metadata),metadata).includes('fingerprint.evidence.execution.payoff invalid_ref'));
 // an unknown dimension must not carry items; an empty map is too few
 assert.equal(Object.hasOwn(derive(fp({plotMechanics:[],evidence:{}}),metadata),'sourceBasis'),false);
 // a missing metadata object makes a metadata token an unproven fact: nothing derived
 assert.equal(Object.hasOwn(derive(fp({evidence:{plotMechanics:{heist:[item('metadata',['metadata:synopsis'])],investigation:[item('metadata',['metadata:genres'])]}}}),undefined),'sourceBasis'),false);
}

// 5. Seeded random sweep: for every random valid evidence map the Worker's derivation equals the reference and passes the real validator; a corrupted one never derives.
{
 let seed=20261112;const rnd=()=>(seed=(seed*1664525+1013904223)%4294967296)/4294967296,pick=a=>a[Math.floor(rnd()*a.length)];
 const sub=(a,n)=>{const c=[...a],out=[];while(out.length<n&&c.length)out.push(c.splice(Math.floor(rnd()*c.length),1)[0]);return out;};
 const items=(allowMeta)=>Array.from({length:1+Math.floor(rnd()*3)},()=>{
  const kind=pick(allowMeta?['metadata','model_knowledge','web_research']:['model_knowledge','web_research']);
  if(kind==='metadata')return item('metadata',sub(['metadata:synopsis','metadata:genres','metadata:runtime','metadata:credits'],1+Math.floor(rnd()*3)),pick(['low','medium','high']));
  if(kind==='model_knowledge')return item('model_knowledge',['model_knowledge'],pick(['low','medium','high']));
  return item('web_research',Array.from({length:1+Math.floor(rnd()*4)},()=>'https://example.com/r/'+Math.floor(rnd()*30)).filter((u,i,a)=>a.indexOf(u)===i),pick(['low','medium','high']));
 });
 const dedup=list=>{const seen=new Set();return list.filter(it=>{const k=JSON.stringify([it.basis,it.refs,it.confidence]);if(seen.has(k))return false;seen.add(k);return true;});};
 let derived=0;
 for(let n=0;n<300;n++){
  const mech=sub(MECHANICS,1+Math.floor(rnd()*3)),dims=sub(GENERAL.filter(k=>EXECUTION[k].some(v=>v!=='unknown'&&v!=='not_applicable')),Math.floor(rnd()*6)),genre=rnd()<.4?sub(GENRE,1):[];
  const execution={},evidence={plotMechanics:{},execution:{}};
  for(const m of mech)evidence.plotMechanics[m]=dedup(items(true));
  for(const k of dims){execution[k]=EXECUTION[k].find(v=>v!=='unknown'&&v!=='not_applicable');evidence.execution[k]=dedup(items(false));}
  for(const k of genre){execution[k]=EXECUTION[k].find(v=>v!=='unknown'&&v!=='not_applicable');if(rnd()<.5)evidence.execution[k]=dedup(items(false));}
  if(!Object.keys(evidence.execution).length)delete evidence.execution;
  const f=fp({plotMechanics:mech,execution,evidence}),d=derive(f,metadata),ref=reference(f);
  assert.deepEqual({sourceBasis:d.sourceBasis,sourceRefs:d.sourceRefs},ref,'case '+n);
  assert.deepEqual(issues(d,metadata),[],'case '+n+': the derived fingerprint is valid');
  assert.deepEqual(issues({...f,...ref},metadata),[],'case '+n+': the reference spelled out by a caller is valid too');
  derived++;
  // corrupt one claim: no derivation
  const bad=structuredClone(f);bad.evidence.plotMechanics[mech[0]]=[item('web_research',['http://example.com/not-https'])];
  assert.equal(Object.hasOwn(derive(bad,metadata),'sourceBasis'),false,'case '+n+': corrupted evidence derives nothing');
 }
 assert.equal(derived,300);
}

// 6. Submit and validate agree: the MCP validator, the v5 submit, the v2 submit and the dry run all accept the omitted form, store the derived fields, and give the same content hash as the spelled-out form.
{
 const {flowWorld}=await import('./prediction-d1-flow-lib.mjs');
 const {sqliteSync}=await import('./sqlite-session.mjs');
 const mkWorld=async()=>{const w=await flowWorld({films:6});assert.equal((await w.api('queue/reconcile',{})).status,200);vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);w.call=async(name,args)=>{w.ctx.__a={name,args};w.ctx.__env=w.env;const r=await vm.runInContext('mcpCallTool({name:__a.name,arguments:__a.args},"2025-06-18",__env,{waitUntil(){}})',w.ctx);const res=r.result;return {isError:!!res.isError,data:res.isError?res.content[0].text:JSON.parse(res.content[0].text)};};return w;};
 const evidence={plotMechanics:{heist:[item('web_research',['https://example.com/a'])],investigation:[item('model_knowledge',['model_knowledge'])]}};
 const expectedAgg={sourceBasis:'mixed',sourceRefs:['https://example.com/a','model_knowledge']};
 const prediction={predictedRating:3.5,probability4Plus:.45,confidence:'medium',matchSignals:['Investigation'],mainRisk:'Mixed payoff',moodLabels:['мрачный','напряжённый']};
 const storedFp=(w,id)=>{const row=sqliteSync([w.file,'-json'],{input:"SELECT * FROM prediction_fingerprint WHERE film_id='"+id+"';",encoding:'utf8'});return row.stdout;};
 const hashes=[];
 for(const form of ['omitted','spelled']){
  const w=await mkWorld(),start=await w.call('prediction_batch_start',{trigger:'scheduled'});assert.ok(!start.isError,JSON.stringify(start.data).slice(0,160));
  const film=start.data.films[0],id=film.filmId,meta=film.modelMetadata;
  const f=fp({evidence,...(form==='spelled'?expectedAgg:{})});
  // the MCP validator (with the film's metadata only when a token needs it)
  const v=await w.call('prediction_validate',{fingerprint:f,prediction});assert.equal(v.data.valid,true,JSON.stringify(v.data).slice(0,300));
  const r=await w.call('prediction_batch_submit',{runId:start.data.runId,epoch:start.data.lease.epoch,items:[{filmId:id,fingerprint:f,prediction}]});
  assert.ok(!r.isError,JSON.stringify(r.data).slice(0,300));
  const key=[...w.records.keys()].find(k=>k.startsWith('enrichment/films/'+id+'/fingerprints/')&&!k.includes('generations')&&/\/[0-9a-f]{64}\.json$/.test(k));assert.ok(key,'the immutable fingerprint body is stored');
  const body=w.records.get(key);assert.equal(body.sourceBasis,'mixed','the stored body holds the derived basis');assert.deepEqual(body.sourceRefs,expectedAgg.sourceRefs,'and the derived refs');
  hashes.push([form,r.data.results[0].status,key.split('/').pop()]);
  if(form==='omitted'){assert.equal(r.data.results[0].status,'created',JSON.stringify(r.data.results[0]));}
 }
 assert.deepEqual(hashes.map(x=>x[1]),['created','created']);
 assert.equal(hashes[0][2],hashes[1][2],'the omitted and the spelled-out form store the same content hash');
}
// 7. The dry run and the v5 submit apply the same rule (one contract for every submit path), and a wrong supplied aggregate is still rejected on each.
{
 const {flowWorld}=await import('./prediction-d1-flow-lib.mjs');
 const evidence={plotMechanics:{heist:[item('web_research',['https://example.com/a'])],investigation:[item('model_knowledge',['model_knowledge'])]}};
 const prediction={predictedRating:3.5,probability4Plus:.45,confidence:'medium',matchSignals:['Investigation'],mainRisk:'Mixed payoff',moodLabels:['мрачный','напряжённый']};
 // dry run
 {const w=await flowWorld({films:4});assert.equal((await w.api('queue/reconcile',{})).status,200);
  const m=(await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',dryRun:true})).data,id=m.films[0].filmId;
  const dry=(f)=>w.api('batch/submit',{runId:'dry-run',epoch:1,dryRun:true,manifestHash:m.manifestHash,items:[{filmId:id,fingerprint:f,prediction,inputHash:m.films[0].inputHash}]});
  assert.equal((await dry(fp({evidence}))).data.results[0].status,'would_write','omitted: the dry run derives');
  assert.equal((await dry(fp({evidence,sourceBasis:'mixed',sourceRefs:['https://example.com/a','model_knowledge']}))).data.results[0].status,'would_write');
  const bad=(await dry(fp({evidence,sourceBasis:'web_research',sourceRefs:['https://example.com/a','model_knowledge']}))).data.results[0];assert.equal(bad.status,'validation_failure');assert.deepEqual(bad.validation.issues,[{path:'fingerprint.sourceBasis',code:'invalid_enum'}]);
  const wrongRefs=(await dry(fp({evidence,sourceBasis:'mixed',sourceRefs:[]}))).data.results[0];assert.deepEqual(wrongRefs.validation.issues,[{path:'fingerprint.sourceRefs',code:'invalid_ref'}],'the AIR-450 C3 shape is still rejected when the caller supplies it');
  const broken=(await dry(fp({evidence:{plotMechanics:{heist:[item('web_research',['http://x.example/a'])],investigation:[item('model_knowledge',['model_knowledge'])]}}}))).data.results[0];assert.deepEqual(broken.validation.issues,[{path:'fingerprint.evidence.plotMechanics.heist',code:'invalid_ref'}],'invalid evidence: its own issue only');
 }
 // v5 submit
 {const w=await flowWorld({films:4});assert.equal((await w.api('queue/reconcile',{})).status,200);
  const start=await w.api('start',{scope:'watchlist_all',capacity:{remainingPercent:100}});assert.equal(start.status,200);
  const next=await w.api('next',{runId:start.data.runId,batchSize:1});const id=next.data.items[0].filmId;
  const bad=await w.api('submit',{runId:start.data.runId,items:[{filmId:id,fingerprint:fp({evidence,sourceBasis:'mixed',sourceRefs:[]}),prediction}]});
  assert.equal(bad.data.results[0].validation.issues[0].path,'fingerprint.sourceRefs');
  const next2=await w.api('next',{runId:start.data.runId,batchSize:1});const id2=next2.data.items?.[0]?.filmId||id;
  const ok=await w.api('submit',{runId:start.data.runId,items:[{filmId:id2,fingerprint:fp({evidence}),prediction}]});
  assert.ok(['created','recalculated'].includes(ok.data.results[0].status),JSON.stringify(ok.data.results[0]).slice(0,300));
 }
}
// 8. Evidence that is not a map at all (null, a list, a string, a number, a boolean) is an invalid map like any other: only its own issue is reported, the omitted fields are not reported as missing on top
// of it, and a genuinely supplied wrong field is still reported. Through fingerprintIssues, prediction_validate and a submit path.
{
 const {flowWorld}=await import('./prediction-d1-flow-lib.mjs');
 const prediction={predictedRating:3.5,probability4Plus:.45,confidence:'medium',matchSignals:['Investigation'],mainRisk:'Mixed payoff',moodLabels:['мрачный','напряжённый']};
 const nonMaps=[null,[],['x'],'text',5,true];
 for(const bad of nonMaps){
  const label=JSON.stringify(bad);
  assert.deepEqual(issues(fp({evidence:bad}),metadata),['fingerprint.evidence invalid_type'],'omitted fields, evidence '+label);
  assert.equal(Object.hasOwn(derive(fp({evidence:bad}),metadata),'sourceBasis'),false,'nothing derived from '+label);
  assert.deepEqual(issues(fp({evidence:bad,sourceBasis:'model_knowledge',sourceRefs:['model_knowledge']}),metadata),['fingerprint.evidence invalid_type'],'supplied fields, evidence '+label);
  // a supplied wrong field is a genuine error and stays; the field that was omitted is still not reported as missing
  const wrongBasis=issues(fp({evidence:bad,sourceBasis:'bogus'}),metadata);
  assert.ok(wrongBasis.includes('fingerprint.sourceBasis invalid_enum')&&wrongBasis.includes('fingerprint.evidence invalid_type'),'a supplied wrong field is not hidden: '+wrongBasis);
  assert.ok(!wrongBasis.includes('fingerprint.sourceRefs required'),'the omitted field is not reported as missing: '+wrongBasis);
 }
 // through prediction_validate and the dry-run submit on the real handlers
 const w=await flowWorld({films:4});assert.equal((await w.api('queue/reconcile',{})).status,200);
 vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);
 const call2=async(name,args)=>{w.ctx.__a={name,args};w.ctx.__env=w.env;const r=await vm.runInContext('mcpCallTool({name:__a.name,arguments:__a.args},"2025-06-18",__env,{waitUntil(){}})',w.ctx);return JSON.parse(r.result.content[0].text);};
 const m=(await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',dryRun:true})).data,id=m.films[0].filmId;
 for(const bad of nonMaps){
  const v=await call2('prediction_validate',{fingerprint:fp({evidence:bad}),prediction});
  assert.equal(v.valid,false);assert.deepEqual(v.fingerprint.issues,[{path:'fingerprint.evidence',code:'invalid_type'}],'prediction_validate, evidence '+JSON.stringify(bad));
  const r=(await w.api('batch/submit',{runId:'dry-run',epoch:1,dryRun:true,manifestHash:m.manifestHash,items:[{filmId:id,fingerprint:fp({evidence:bad}),prediction,inputHash:m.films[0].inputHash}]})).data.results[0];
  assert.equal(r.status,'validation_failure');assert.deepEqual(r.validation.issues,[{path:'fingerprint.evidence',code:'invalid_type'}],'dry-run submit, evidence '+JSON.stringify(bad));
 }
}
console.log('fingerprint-source-derivation ok');
