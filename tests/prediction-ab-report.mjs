// AIR-450: the offline A/B aggregator (scripts/prediction-ab-report.mjs). Synthetic fixtures only: no model, no production record, no network. It proves the arithmetic on a hand-checked case,
// the fail-closed identity checks between passes, the honest handling of missing ground truth and telemetry, and that the output is sanitized (no fingerprint, prediction or free text can leave).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {buildReport,checkPasses,assertSanitized,renderMarkdown,AbReportError} from '../scripts/prediction-ab-report.mjs';
import {check} from './json-schema-lite.mjs';

const schema=JSON.parse(fs.readFileSync('docs/reference/scheduled-task-prompts/batch-v2-ab.schema.json','utf8'));
const HASH='a'.repeat(64),PH='abcdef12';
const pred=(rating,p,signals=['Investigation','Causal puzzle'],risk='Mixed payoff',conf='medium')=>({predictedRating:rating,probability4Plus:p,confidence:conf,matchSignals:signals,mainRisk:risk,moodLabels:['мрачный','напряжённый']});
const pass=(size,ids,make,extra={})=>({schemaVersion:1,sampleId:'s1',groupSize:size,manifestHash:HASH,profile:{version:1,hash:PH},contract:{fingerprintSchemaVersion:1,fingerprintPromptVersion:1,predictionPromptVersion:1,registryDigest:'abcdef12'},
 films:ids.map((id,i)=>({filmId:id,plan:'prediction_only',groupIndex:Math.floor(i/size),callId:Math.floor(i/size),fingerprint:null,prediction:make(id,i),submitStatus:'would_write',liveInput:'same',validation:null,generationMs:null})),
 calls:Array.from({length:Math.ceil(ids.length/size)},(_,g)=>({callId:g,groupIndex:g,itemCount:Math.min(size,ids.length-g*size),bodyBytes:1000,toolMs:null,ok:true,observedProfileHash:PH})),
 telemetry:{model:null,tokens:null,quota:null,wallMs:null,unavailable:['model','tokens','quota','wallMs','generationMs','toolMs']},...extra});

// 1. Hand-checked arithmetic: three films, sizes 1 and 2.
{
 const ids=['a','b','c'];
 const p1=pass(1,ids,(id)=>({a:pred(4,.8),b:pred(3,.4),c:pred(5,.9)})[id]);
 const p2=pass(2,ids,(id)=>({a:pred(4.5,.7),b:pred(3,.5),c:pred(4,.9)})[id]);
 const truth={a:4.5,b:2.5,c:5,zzz:3};
 const r=buildReport([p2,p1],{truth});
 assert.deepEqual(r.identity.sizes,[1,2]);assert.equal(r.identity.baselineSize,1);assert.equal(r.quality.truth.films,3,'a truth id outside the sample is ignored');
 const [s1,s2]=r.perSize;
 assert.equal(s1.truth.n,3);assert.equal(s1.truth.mae,round(((.5)+(.5)+0)/3));assert.equal(s1.truth.bias,round((-.5+.5+0)/3));assert.equal(s1.truth.threshold4Accuracy,1);
 assert.equal(s2.truth.mae,round((0+.5+1)/3));assert.equal(s2.truth.bias,round((0+.5-1)/3));assert.equal(s2.truth.threshold4Accuracy,1,'4.5 and 4.5, 3 and 2.5, 4 and 5 all fall on the same side of 4.0');
 const a=s2.agreementToBaseline;assert.equal(a.pairs,3);assert.equal(a.predictedRatingAbsDiff.max,1);assert.equal(a.predictedRatingAbsDiff.mean,round((.5+0+1)/3));assert.equal(a.confidenceAgreement,1);assert.equal(a.matchSignalsOverlap.mean,1);assert.equal(s1.agreementToBaseline,undefined,'the baseline has no agreement block');
 assert.equal(r.stability.predictedRatingSpread.max,1);assert.equal(s1.cost.mcpCalls,3);assert.equal(s2.cost.mcpCalls,2);assert.equal(s2.cost.bodyBytes.total,2000);assert.equal(s2.cost.toolMs,null,'a missing metric stays null, never estimated');
 assert.ok(r.unknown.includes('telemetry_tokens')&&r.unknown.includes('telemetry_toolMs'));assert.ok(!r.unknown.includes('no_ground_truth'));
 assert.deepEqual(check(schema.$defs.report,r),[]);
}
function round(x){return Math.round(x*1e4)/1e4;}

// 2. No ground truth is said plainly; invalid films are counted, not scored; a missing baseline is named.
{
 const ids=['a','b'];const base=pass(2,ids,()=>pred(3,.5));base.films[1]={...base.films[1],submitStatus:'validation_failure',prediction:null,validation:{stage:'prediction_schema',issues:[{path:'predictedRating',code:'invalid'}]}};
 const r=buildReport([base]);assert.equal(r.quality.truth.available,false);assert.equal(r.quality.truth.basis,'agreement_to_baseline_only');assert.match(renderMarkdown(r),/not ground truth/);assert.ok(r.unknown.includes('no_ground_truth')&&r.unknown.includes('no_size_1_baseline'));
 assert.equal(r.perSize[0].validShare,.5);assert.equal(r.perSize[0].statuses.validation_failure,1);assert.equal(r.perSize[0].truth,undefined);
 assert.deepEqual(check(schema.$defs.report,r),[]);
}

// 3. Fail closed: different manifest, sample, identity, film order, duplicate size, a group above its size, an unsafe film id.
{
 const ids=['a','b','c'],mk=(s,extra)=>pass(s,ids,()=>pred(3,.5),extra);
 const code=(fn)=>{try{fn();}catch(e){assert.ok(e instanceof AbReportError);return e.code;}throw new Error('expected a refusal');};
 assert.equal(code(()=>buildReport([mk(1),mk(2,{manifestHash:'b'.repeat(64)})])),'manifest_mismatch');
 assert.equal(code(()=>buildReport([mk(1),mk(2,{sampleId:'s2'})])),'sample_mismatch');
 assert.equal(code(()=>buildReport([mk(1),mk(2,{profile:{version:2,hash:'abcdef99'}})])),'identity_mismatch');
 assert.equal(code(()=>buildReport([mk(1),{...mk(2),films:[...mk(2).films].reverse()}])),'film_set_mismatch');
 assert.equal(code(()=>buildReport([mk(1),mk(1)])),'duplicate_size');
 assert.equal(code(()=>buildReport([mk(3,{calls:[{callId:0,groupIndex:0,itemCount:4,bodyBytes:1,toolMs:null,ok:true,observedProfileHash:PH}]})])),'group_size_exceeded');
 assert.equal(code(()=>buildReport([pass(1,['A/../b'],()=>pred(3,.5))])),'invalid_input','an unsafe film id is refused by the input schema');
 assert.equal(code(()=>buildReport([])),'no_results');
}

// 4. Sanitization and adversarial inputs. Every alphanumeric secret an input can carry must either be refused by the strict input schema (with an error that never echoes it) or stay out of the report, the Markdown and the CLI output.
{
 const SECRET='SECRETPRIVATETASTE',ids=Array.from({length:12},(_,i)=>'tmdb_'+(i+1));
 const base=()=>[1,2,3].map(s=>pass(s,ids,(id,i)=>pred(2+(i%7)/2,.3+(i%5)/10,[SECRET,'x'],SECRET)));
 // free-text fields that the schema allows are used for numbers only and never copied
 const results=base();
 for(const r of results){r.films.forEach(f=>{f.fingerprint={plotMechanics:['heist'],execution:{pace:'strong'},note:SECRET};f.validation=null;});r.telemetry.model=SECRET;r.notes=SECRET;r.calls.forEach(c=>{c.error=SECRET;});}
 results[0].films[0]={...results[0].films[0],submitStatus:'validation_failure',prediction:null,validation:{stage:'prediction_schema',issues:[{path:SECRET,code:SECRET}]}};
 const report=buildReport(results,{modelLabel:'gpt-test.1'});
 const out=JSON.stringify(report)+renderMarkdown(report);assert.ok(!out.includes(SECRET),'no private string reaches the report or the Markdown');assert.equal(report.model,'gpt-test.1','the model is an owner label, never read from a record');
 assert.equal(buildReport(results).model,null);assert.deepEqual(check(schema.$defs.report,report),[]);
 // the invalid inputs of the review: an unknown status, an extra profile key, extra keys at any level, a bad hash, a secret in an id, in the sample id, a bad model label
 const refuse=(mutate,label)=>{const rs=base();mutate(rs);let message='';try{buildReport(rs);}catch(e){assert.ok(e instanceof AbReportError,label);assert.equal(e.code,'invalid_input',label);message=e.message;}assert.ok(message,'refused: '+label);assert.ok(!message.includes(SECRET),'the error does not echo the value: '+label);};
 refuse(rs=>{rs[0].films[0].submitStatus=SECRET;},'unknown submitStatus');
 refuse(rs=>{rs[0].profile.privateNote=SECRET;},'extra profile key');
 refuse(rs=>{rs[0][SECRET]=1;},'extra top-level key');
 refuse(rs=>{rs[0].films[0][SECRET]=1;},'extra film key');
 refuse(rs=>{rs[0].calls[0][SECRET]=1;},'extra call key');
 refuse(rs=>{rs[0].telemetry[SECRET]=1;},'extra telemetry key');
 refuse(rs=>{rs[0].contract.registryDigest=SECRET;},'non-hex registry digest');
 refuse(rs=>{rs[0].profile.hash=SECRET;},'non-hex profile hash');
 refuse(rs=>{rs[0].films[0].filmId=SECRET;},'film id with uppercase');
 refuse(rs=>{rs[0].sampleId=SECRET;},'sample id with uppercase');
 refuse(rs=>{rs[0].films[0].validation={stage:SECRET,issues:[]};},'validation stage');
 refuse(rs=>{rs[0].telemetry.unavailable=[SECRET];},'unavailable entry');
 refuse(rs=>{rs[0].stoppedReason=SECRET;},'stoppedReason');
 refuse(rs=>{rs[0].films[0].prediction.predictedRating=9;},'rating out of range');
 refuse(rs=>{rs[0].films[0].prediction.probability4Plus=2;},'probability out of range');
 assert.throws(()=>buildReport(base(),{modelLabel:SECRET+'!'}),e=>e.code==='invalid_model_label');
 // the closed report gate rejects what the builder did not whitelist
 assert.throws(()=>assertSanitized({...report,extra:1}),e=>e.code==='unsanitized_report');
 assert.throws(()=>assertSanitized({...report,identity:{...report.identity,sampleId:SECRET}}),e=>e.code==='unsanitized_report');
 assert.throws(()=>assertSanitized({...report,perSize:[{...report.perSize[0],statuses:{...report.perSize[0].statuses,[SECRET]:1}}]}),e=>e.code==='unsanitized_report');
 // the CLI: parse errors and refusals print a code, never a payload
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ab-adv-'));const bad=path.join(dir,'bad.json');fs.writeFileSync(bad,'{"x": '+SECRET+'}');
 const r1=spawnSync(process.execPath,['scripts/prediction-ab-report.mjs','--results',bad],{encoding:'utf8'});assert.equal(r1.status,1);assert.ok(!(r1.stdout+r1.stderr).includes(SECRET)&&/invalid_json/.test(r1.stderr),'a JSON parse error never quotes the source');
 const leaky=base()[0];leaky.profile.privateNote=SECRET;const lk=path.join(dir,'leaky.json');fs.writeFileSync(lk,JSON.stringify(leaky));
 const r2=spawnSync(process.execPath,['scripts/prediction-ab-report.mjs','--results',lk],{encoding:'utf8'});assert.equal(r2.status,1);assert.ok(!(r2.stdout+r2.stderr).includes(SECRET)&&/invalid_input/.test(r2.stderr));
 const good=path.join(dir,'good.json');fs.writeFileSync(good,JSON.stringify(results[0]));
 const r3=spawnSync(process.execPath,['scripts/prediction-ab-report.mjs','--results',good,'--model-label','x1'],{encoding:'utf8'});assert.equal(r3.status,0,r3.stderr);assert.ok(!r3.stdout.includes(SECRET));
 fs.rmSync(dir,{recursive:true});
}

// 4b. Comparability: a changed live input, a moved profile and a stopped pass are excluded from every quality metric and named; a partial report is a diagnostic, not final.
{
 const ids=['a','b','c','d'];const truth={a:4,b:3,c:5,d:2};
 const p1=pass(1,ids,(id)=>pred(truth[id],.5));
 const p2=pass(2,ids,(id)=>pred(truth[id]===4?1:truth[id],.5)); // film a would be wildly wrong, but its live input changed
 p2.films[0].liveInput='changed';
 const r=buildReport([p1,p2],{truth});const s2=r.perSize[1];
 assert.equal(s2.comparableFilms,3);assert.equal(s2.excluded.liveInputChanged,1);assert.equal(s2.validShare,.75);assert.equal(s2.truth.n,3);assert.equal(s2.truth.mae,0,'the changed film does not contaminate MAE');assert.equal(s2.agreementToBaseline.pairs,3);
 assert.equal(r.completeness.final,false);assert.deepEqual(r.completeness.missingSizes,[3,4,5,6,7,8,9,10]);assert.ok(r.unknown.includes('partial_sizes')&&r.unknown.includes('partial_films'));assert.match(renderMarkdown(r),/PARTIAL DIAGNOSTIC/);assert.equal(r.completeness.ownerAcceptance,'required');
 // a call whose observed profile hash differs: its films are stale, the pass stopped, the rest not submitted
 const q2=pass(2,ids,(id)=>pred(truth[id],.5));q2.calls[0].observedProfileHash='abcdef99';q2.calls[1].observedProfileHash='abcdef99';
 const rq=buildReport([p1,q2],{truth});assert.equal(rq.perSize[1].comparableFilms,0);assert.equal(rq.perSize[1].excluded.staleProfile,4);assert.equal(rq.perSize[1].profileMismatchCalls,2);assert.ok(rq.unknown.includes('profile_moved'));
 const q3=pass(2,ids,(id)=>pred(truth[id],.5));q3.calls=[{...q3.calls[0]},{...q3.calls[1],observedProfileHash:null}];q3.films[2].submitStatus='not_submitted';q3.films[3].submitStatus='not_submitted';q3.films[2].callId=null;q3.films[3].callId=null;q3.films[2].prediction=null;q3.films[3].prediction=null;q3.stoppedReason='profile_moved';q3.calls=[q3.calls[0]];
 const rs=buildReport([p1,q3],{truth});assert.equal(rs.perSize[1].comparableFilms,2);assert.equal(rs.perSize[1].statuses.not_submitted,2);assert.equal(rs.perSize[1].stoppedReason,'profile_moved');
 // an unobserved profile hash on a submitted film is stale too (the check is required)
 const q4=pass(1,ids,(id)=>pred(truth[id],.5));q4.calls.forEach(c=>{c.observedProfileHash=null;});assert.equal(buildReport([q4]).perSize[0].comparableFilms,0);
 // a complete 100-film, ten-size set is final
 const many=Array.from({length:100},(_,i)=>'tmdb_'+(2000+i));const full=buildReport(Array.from({length:10},(_,k)=>pass(k+1,many,()=>pred(3,.5))));assert.equal(full.completeness.final,true);assert.ok(!full.unknown.includes('partial_sizes'));
}

// 4c. Association by explicit callId, never by array position (the review's counterexample), and fail-closed on anything ambiguous.
{
 const ids=['a','b','c','d'],MOVED='abcdef99',mk=()=>pass(2,ids,()=>pred(3,.5)),code=fn=>{try{fn();}catch(e){assert.ok(e instanceof AbReportError);return e.code;}throw new Error('expected a refusal');};
 const base1=()=>pass(1,ids,()=>pred(3,.5)),compare=(r)=>buildReport([base1(),r]).perSize[1];
 // reordered calls: group 0 moved, group 1 fine; the array order is reversed
 const re=mk();re.calls=[{...re.calls[1],observedProfileHash:PH},{...re.calls[0],observedProfileHash:MOVED}];
 let row=compare(re);assert.equal(row.comparableFilms,2);assert.equal(row.excluded.staleProfile,2,'group 0 (callId 0) is stale and group 1 is not, whatever the array order');assert.equal(row.profileMismatchCalls,1);
 // the review's exact counterexample: calls=[{groupIndex:1,matching},{groupIndex:0,moved}] must not certify group 0 with the first entry
 const ce=mk();ce.calls=[{callId:1,groupIndex:1,itemCount:2,bodyBytes:1,toolMs:null,ok:true,observedProfileHash:PH},{callId:0,groupIndex:0,itemCount:2,bodyBytes:1,toolMs:null,ok:true,observedProfileHash:MOVED}];
 row=compare(ce);assert.deepEqual([row.comparableFilms,row.excluded.staleProfile],[2,2]);
 const group0=ce.films.filter(f=>f.groupIndex===0).map(f=>f.filmId);assert.deepEqual(group0,['a','b']);
 // a group split over several calls: a and b in two calls of group 0, only b's call moved; plus a refused attempt and a retry that no film names
 const sp=mk();sp.films[0].callId=0;sp.films[1].callId=1;sp.films[2].callId=3;sp.films[3].callId=3;
 sp.calls=[{callId:0,groupIndex:0,itemCount:1,bodyBytes:1,toolMs:null,ok:true,observedProfileHash:PH},{callId:1,groupIndex:0,itemCount:1,bodyBytes:1,toolMs:null,ok:true,observedProfileHash:MOVED},{callId:2,groupIndex:0,itemCount:2,bodyBytes:99999,toolMs:null,ok:false,observedProfileHash:null},{callId:3,groupIndex:1,itemCount:2,bodyBytes:1,toolMs:null,ok:true,observedProfileHash:PH}];
 row=compare(sp);assert.equal(row.comparableFilms,3);assert.equal(row.excluded.staleProfile,1,'only the film of the moved call is stale');assert.equal(row.sizeRefusals,1);assert.equal(row.profileMismatchCalls,1,'the refused attempt names no film and is not a profile mismatch');
 // ambiguity is refused: dangling callId, duplicate callId, a film naming a call of another group, a grouping that differs from the frozen one, a not_submitted film naming a call, more films than a call holds
 const bad=(edit,expected,label)=>{const r=mk();edit(r);assert.equal(code(()=>buildReport([base1(),r])),expected,label);};
 bad(r=>{r.films[0].callId=9;},'call_mapping','dangling callId');
 bad(r=>{r.calls[1].callId=0;},'call_mapping','duplicate callId');
 bad(r=>{r.films[0].callId=1;},'call_mapping','a film naming a call of another group');
 bad(r=>{r.films[1].groupIndex=1;},'group_mapping','groupIndex differs from the frozen grouping');
 bad(r=>{r.films[3].submitStatus='not_submitted';},'call_mapping','a not_submitted film must name no call');
 bad(r=>{r.calls[0].itemCount=1;},'call_mapping','a call that holds fewer items than films naming it');
 bad(r=>{r.films[0].callId=undefined;delete r.films[0].callId;},'invalid_input','a film without callId');
}

// 4d. failureReason: counted per size over the failed films with fixed keys; a missing value is `unspecified`; anything outside the closed list is refused (the value never reaches the report).
{
 const ids=['a','b','c','d','e'],p1=pass(1,ids,()=>pred(3,.5)),p2=pass(2,ids,()=>pred(3,.5));
 const fail=(f,reason)=>{f.submitStatus='validation_failure';f.prediction=null;f.validation={stage:'caller_reported',issues:[]};if(reason!==undefined)f.failureReason=reason;};
 fail(p2.films[0],'insufficient_metadata');fail(p2.films[1],'insufficient_knowledge');fail(p2.films[2],'insufficient_metadata');fail(p2.films[3]);
 const r=buildReport([p1,p2]);assert.deepEqual(r.perSize[1].failureReasons,{insufficient_metadata:2,insufficient_knowledge:1,json_unparseable:0,other:0,unspecified:1});
 assert.deepEqual(r.perSize[0].failureReasons,{insufficient_metadata:0,insufficient_knowledge:0,json_unparseable:0,other:0,unspecified:0});assert.deepEqual(check(schema.$defs.report,r),[]);
 const bad=pass(2,ids,()=>pred(3,.5));fail(bad.films[0],'SECRETREASON');
 try{buildReport([p1,bad]);assert.fail('expected a refusal');}catch(e){assert.ok(e instanceof AbReportError);assert.equal(e.code,'invalid_input');assert.ok(!e.message.includes('SECRETREASON'));}
 const ok=pass(2,ids,()=>pred(3,.5));ok.films[0].failureReason=null;assert.doesNotThrow(()=>buildReport([p1,ok]));
}

// 5. A full shape: 100 films, ten passes, with a deterministic generator whose noise grows with the group size, and the CLI end to end on private temp files.
{
 const ids=Array.from({length:100},(_,i)=>'tmdb_'+(1000+i));let seed=7;const rnd=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;
 const truth=Object.fromEntries(ids.map((id,i)=>[id,[2.5,3,3.5,4,4.5,5][i%6]]));
 const results=Array.from({length:10},(_,k)=>pass(k+1,ids,(id,i)=>pred(Math.min(5,Math.max(.5,Math.round((truth[id]+(rnd()-.5)*(k+1)*.2)*2)/2)),Math.min(1,Math.max(0,.5+(rnd()-.5)*.1)))));
 const report=buildReport(results,{truth});
 assert.equal(report.perSize.length,10);assert.equal(report.identity.films,100);assert.deepEqual(check(schema.$defs.report,report),[]);
 assert.ok(report.perSize[9].truth.mae>=report.perSize[0].truth.mae,'the synthetic noise grows with the size');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ab-report-'));const resDir=path.join(dir,'private');fs.mkdirSync(resDir);
 results.forEach(r=>fs.writeFileSync(path.join(resDir,'pass-'+r.groupSize+'.json'),JSON.stringify(r)));fs.writeFileSync(path.join(dir,'truth.json'),JSON.stringify(truth));
 const out=path.join(dir,'report.json'),md=path.join(dir,'report.md');
 const run=spawnSync(process.execPath,['scripts/prediction-ab-report.mjs','--results',resDir,'--truth',path.join(dir,'truth.json'),'--out',out,'--markdown',md],{encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(fs.readFileSync(out,'utf8')),report);assert.match(fs.readFileSync(md,'utf8'),/Batch runner v2 dry-run A\/B report/);
 fs.writeFileSync(path.join(resDir,'pass-11.json'),JSON.stringify({...results[0],manifestHash:'c'.repeat(64),groupSize:5}));
 const bad=spawnSync(process.execPath,['scripts/prediction-ab-report.mjs','--results',resDir,'--out',out],{encoding:'utf8'});assert.equal(bad.status,1);assert.match(bad.stderr,/manifest_mismatch/,'the CLI refuses a pass of another manifest');
 fs.rmSync(dir,{recursive:true});
}
console.log('prediction-ab-report ok');
