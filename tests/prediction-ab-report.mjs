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
const HASH='a'.repeat(64);
const pred=(rating,p,signals=['Investigation','Causal puzzle'],risk='Mixed payoff',conf='medium')=>({predictedRating:rating,probability4Plus:p,confidence:conf,matchSignals:signals,mainRisk:risk,moodLabels:['мрачный','напряжённый']});
const pass=(size,ids,make,extra={})=>({schemaVersion:1,sampleId:'S1',groupSize:size,manifestHash:HASH,profile:{version:1,hash:'p'},contract:{fingerprintSchemaVersion:1,fingerprintPromptVersion:1,predictionPromptVersion:1,registryDigest:'d'},
 films:ids.map((id,i)=>({filmId:id,plan:'prediction_only',groupIndex:Math.floor(i/size),fingerprint:null,prediction:make(id,i),submitStatus:'would_write',liveInput:'same',validation:null,generationMs:null})),
 calls:Array.from({length:Math.ceil(ids.length/size)},(_,g)=>({groupIndex:g,itemCount:Math.min(size,ids.length-g*size),bodyBytes:1000,toolMs:null,ok:true})),
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
 assert.equal(code(()=>buildReport([mk(1),mk(2,{sampleId:'S2'})])),'sample_mismatch');
 assert.equal(code(()=>buildReport([mk(1),mk(2,{profile:{version:2,hash:'q'}})])),'identity_mismatch');
 assert.equal(code(()=>buildReport([mk(1),{...mk(2),films:[...mk(2).films].reverse()}])),'film_set_mismatch');
 assert.equal(code(()=>buildReport([mk(1),mk(1)])),'duplicate_size');
 assert.equal(code(()=>buildReport([mk(3,{calls:[{groupIndex:0,itemCount:4,bodyBytes:1,toolMs:null,ok:true}]})])),'group_size_exceeded');
 assert.equal(code(()=>buildReport([pass(1,['a/../b'],()=>pred(3,.5))])),'unsafe_film_id');
 assert.equal(code(()=>buildReport([])),'no_results');
}

// 4. Sanitization: whatever the inputs hold, the report carries no payload or free text; the guard rejects what would leak.
{
 const ids=Array.from({length:12},(_,i)=>'tmdb_'+(i+1));
 const secret='SECRET private taste payload "quoted" {json}';
 const results=[1,2,3].map(s=>pass(s,ids,(id,i)=>pred(2+(i%7)/2,.3+(i%5)/10,[secret,'x'],secret),{}));
 for(const r of results)r.films.forEach(f=>{f.fingerprint={plotMechanics:['heist'],execution:{pace:'strong'},note:secret};});
 const report=buildReport(results);const text=JSON.stringify(report);
 assert.ok(!text.includes('SECRET')&&!/"(matchSignals|mainRisk|moodLabels|fingerprint|prediction|synopsis)"/.test(text),'no payload in the report');
 assert.throws(()=>assertSanitized({a:{fingerprint:{}}}),e=>e.code==='forbidden_key');
 assert.throws(()=>assertSanitized({a:'free text with "quotes"'}),e=>e.code==='unsanitized_string');
 assert.throws(()=>assertSanitized({a:'x'.repeat(200)}),e=>e.code==='unsanitized_string');
 assert.doesNotThrow(()=>assertSanitized({a:'tmdb_12',b:1,c:null,d:[true]}));
 const md=renderMarkdown(report);assert.ok(!md.includes('SECRET')&&/\| size \|/.test(md));
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
