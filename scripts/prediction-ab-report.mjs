#!/usr/bin/env node
// AIR-450: offline aggregator of the batch runner v2 dry-run A/B (generation size 1 to 10). It reads the PRIVATE per-pass result records (`$defs.result` of
// docs/reference/scheduled-task-prompts/batch-v2-ab.schema.json) and an optional PRIVATE truth file, and writes a SANITIZED report: numbers, enums, safe identifiers and hashes only.
// It never prints a fingerprint, a prediction, a metadata field or a free-text string, and it never touches production, a model or the network.
// Usage: node scripts/prediction-ab-report.mjs --results <dir|file...> [--truth <file.json>] [--out <report.json>] [--markdown <report.md>]
import fs from 'node:fs';
import path from 'node:path';

const BASELINE=1,THRESHOLD=4;
const sum=a=>a.reduce((x,y)=>x+y,0),mean=a=>a.length?sum(a)/a.length:null;
const round=(x,d=4)=>x===null||x===undefined||!Number.isFinite(x)?null:Math.round(x*10**d)/10**d;
const quantile=(a,q)=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y),i=(s.length-1)*q,lo=Math.floor(i),hi=Math.ceil(i);return s[lo]+(s[hi]-s[lo])*(i-lo);};
const dist=a=>({n:a.length,mean:round(mean(a)),median:round(quantile(a,.5)),p90:round(quantile(a,.9)),max:round(a.length?Math.max(...a):null)});
const tokens=text=>new Set(String(text||'').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t=>t.length>2));
const jaccard=(a,b)=>{if(!a.size&&!b.size)return 1;let i=0;for(const x of a)if(b.has(x))i++;return i/(a.size+b.size-i);};
const signalTokens=p=>tokens([].concat(p?.matchSignals||[]).join(' '));
const SAFE_ID=/^[a-zA-Z0-9_.:-]{1,100}$/;

export class AbReportError extends Error{constructor(code,detail){super(code+(detail?': '+detail:''));this.code=code;}}

// Fail closed: every pass must be the same experiment (one frozen manifest, one sample, the same films in the same order) and each group size appears once.
export function checkPasses(results){
 if(!Array.isArray(results)||!results.length)throw new AbReportError('no_results');
 const first=results[0],sizes=new Set();
 for(const r of results){
  if(r.schemaVersion!==1)throw new AbReportError('schema_version');
  if(r.sampleId!==first.sampleId)throw new AbReportError('sample_mismatch');
  if(r.manifestHash!==first.manifestHash)throw new AbReportError('manifest_mismatch','a pass used another manifest: discard and rerun it');
  if(JSON.stringify(r.profile)!==JSON.stringify(first.profile)||JSON.stringify(r.contract)!==JSON.stringify(first.contract))throw new AbReportError('identity_mismatch','profile or contract differs between passes');
  if(!Number.isInteger(r.groupSize)||r.groupSize<1||r.groupSize>10)throw new AbReportError('group_size');
  if(sizes.has(r.groupSize))throw new AbReportError('duplicate_size',String(r.groupSize));
  sizes.add(r.groupSize);
  if(JSON.stringify(r.films.map(f=>f.filmId))!==JSON.stringify(first.films.map(f=>f.filmId)))throw new AbReportError('film_set_mismatch','the same films in the same order are required in every pass');
  for(const f of r.films)if(!SAFE_ID.test(f.filmId))throw new AbReportError('unsafe_film_id');
  if(r.calls.some(c=>c.itemCount>r.groupSize))throw new AbReportError('group_size_exceeded',String(r.groupSize));
 }
 return [...sizes].sort((a,b)=>a-b);
}

const valid=f=>f.submitStatus==='would_write'||f.submitStatus==='already_current';
const rating=f=>f.prediction&&Number.isFinite(f.prediction.predictedRating)?f.prediction.predictedRating:null;
const prob=f=>f.prediction&&Number.isFinite(f.prediction.probability4Plus)?f.prediction.probability4Plus:null;

export function buildReport(results,{truth=null}={}){
 const sizes=checkPasses(results),by=new Map(results.map(r=>[r.groupSize,r])),first=results[0];
 const baseline=by.get(BASELINE)||null;
 const filmIds=first.films.map(f=>f.filmId);
 const truthIds=truth?new Set(Object.keys(truth).filter(id=>filmIds.includes(id)&&Number.isFinite(truth[id]))):new Set();
 const report={
  schemaVersion:1,kind:'prediction_batch_v2_ab_report',
  identity:{sampleId:first.sampleId,manifestHash:first.manifestHash,profile:first.profile,contract:first.contract,films:filmIds.length,sizes,baselineSize:baseline?BASELINE:null},
  quality:{truth:{available:truthIds.size>0,films:truthIds.size,basis:truthIds.size?'hidden_user_ratings':'agreement_to_baseline_only'}},
  perSize:[],stability:null,unknown:[]
 };
 for(const size of sizes){
  const r=by.get(size),films=r.films,validFilms=films.filter(valid),statuses={};
  for(const f of films)statuses[f.submitStatus]=(statuses[f.submitStatus]||0)+1;
  const row={groupSize:size,films:films.length,statuses,validShare:round(validFilms.length/films.length),sizeRefusals:r.calls.filter(c=>!c.ok).length};
  // cost and timing: only what the pass recorded; a metric with any missing value stays null and is named in `unavailable`.
  const bodyBytes=r.calls.map(c=>c.bodyBytes),toolMs=r.calls.map(c=>c.toolMs),genMs=films.map(f=>f.generationMs);
  const allOf=a=>a.length>0&&a.every(x=>Number.isFinite(x));
  const unavailable=[...(r.telemetry.unavailable||[])];
  row.cost={mcpCalls:r.calls.length,bodyBytes:{total:allOf(bodyBytes)?sum(bodyBytes):null,max:allOf(bodyBytes)?Math.max(...bodyBytes):null},toolMs:allOf(toolMs)?sum(toolMs):null,generationMs:allOf(genMs)?sum(genMs):null,wallMs:r.telemetry.wallMs??null,
   model:r.telemetry.model??null,tokens:r.telemetry.tokens??null,quota:r.telemetry.quota??null,unavailable:[...new Set(unavailable)].sort()};
  if(truthIds.size){
   const rows=validFilms.filter(f=>truthIds.has(f.filmId)&&rating(f)!==null),err=rows.map(f=>rating(f)-truth[f.filmId]);
   row.truth={n:rows.length,mae:round(mean(err.map(Math.abs))),bias:round(mean(err)),threshold4Accuracy:rows.length?round(rows.filter(f=>(rating(f)>=THRESHOLD)===(truth[f.filmId]>=THRESHOLD)).length/rows.length):null};
  }
  if(baseline&&size!==BASELINE){
   const base=new Map(baseline.films.filter(valid).map(f=>[f.filmId,f])),pairs=validFilms.filter(f=>base.has(f.filmId)).map(f=>[base.get(f.filmId),f]);
   const dr=pairs.filter(([a,b])=>rating(a)!==null&&rating(b)!==null).map(([a,b])=>Math.abs(rating(a)-rating(b)));
   const dp=pairs.filter(([a,b])=>prob(a)!==null&&prob(b)!==null).map(([a,b])=>Math.abs(prob(a)-prob(b)));
   const execKeys=([a,b])=>{const ea=a.fingerprint?.execution,eb=b.fingerprint?.execution;if(!ea||!eb)return null;const ks=Object.keys(ea);return ks.length?ks.filter(k=>ea[k]===eb[k]).length/ks.length:null;};
   const mech=([a,b])=>a.fingerprint&&b.fingerprint?jaccard(new Set(a.fingerprint.plotMechanics||[]),new Set(b.fingerprint.plotMechanics||[])):null;
   const execA=pairs.map(execKeys).filter(x=>x!==null),mechA=pairs.map(mech).filter(x=>x!==null);
   row.agreementToBaseline={pairs:pairs.length,predictedRatingAbsDiff:dist(dr),probability4PlusAbsDiff:dist(dp),
    confidenceAgreement:pairs.length?round(pairs.filter(([a,b])=>a.prediction?.confidence===b.prediction?.confidence).length/pairs.length):null,
    threshold4Agreement:dr.length?round(pairs.filter(([a,b])=>rating(a)!==null&&rating(b)!==null&&(rating(a)>=THRESHOLD)===(rating(b)>=THRESHOLD)).length/dr.length):null,
    matchSignalsOverlap:dist(pairs.map(([a,b])=>jaccard(signalTokens(a.prediction),signalTokens(b.prediction)))),
    mainRiskOverlap:dist(pairs.map(([a,b])=>jaccard(tokens(a.prediction?.mainRisk),tokens(b.prediction?.mainRisk)))),
    executionAgreement:execA.length?dist(execA):null,plotMechanicsOverlap:mechA.length?dist(mechA):null,
    fingerprintPairs:execA.length};
  }
  report.perSize.push(row);
 }
 // stability across all sizes for each film that is valid in at least two passes
 const spreads=[],probSpreads=[];
 for(const id of filmIds){
  const rs=sizes.map(s=>by.get(s).films.find(f=>f.filmId===id)).filter(valid),r=rs.map(rating).filter(x=>x!==null),p=rs.map(prob).filter(x=>x!==null);
  if(r.length>=2)spreads.push(Math.max(...r)-Math.min(...r));if(p.length>=2)probSpreads.push(Math.max(...p)-Math.min(...p));
 }
 report.stability={predictedRatingSpread:dist(spreads),probability4PlusSpread:dist(probSpreads)};
 if(!baseline)report.unknown.push('no_size_1_baseline');
 if(!truthIds.size)report.unknown.push('no_ground_truth');
 for(const row of report.perSize)for(const k of row.cost.unavailable)if(!report.unknown.includes('telemetry_'+k))report.unknown.push('telemetry_'+k);
 report.unknown.sort();
 assertSanitized(report);
 return report;
}

// The report is the only thing that may leave the private channel. It holds numbers, booleans, null, enum-like words, safe identifiers and hashes.
const FORBIDDEN_KEYS=/^(fingerprint|prediction|matchSignals|mainRisk|moodLabels|synopsis|title|original|metadata|modelMetadata|profileBody|body|evidence|execution|plotMechanics)$/;
const SAFE_STRING=/^[A-Za-z0-9_.:\- ]{0,160}$/;
export function assertSanitized(value,where='$'){
 if(value===null||typeof value==='number'||typeof value==='boolean')return;
 if(typeof value==='string'){if(!SAFE_STRING.test(value)||/[{}\[\]"]/.test(value))throw new AbReportError('unsanitized_string',where);return;}
 if(Array.isArray(value)){value.forEach((x,i)=>assertSanitized(x,where+'['+i+']'));return;}
 if(typeof value==='object'){for(const [k,v] of Object.entries(value)){if(FORBIDDEN_KEYS.test(k))throw new AbReportError('forbidden_key',where+'.'+k);assertSanitized(v,where+'.'+k);}return;}
 throw new AbReportError('unsanitized_value',where);
}

export function renderMarkdown(report){
 const f=x=>x===null||x===undefined?'n/a':String(x);
 const lines=['# Batch runner v2 dry-run A/B report','',`Sample \`${report.identity.sampleId}\`, manifest \`${report.identity.manifestHash}\`, ${report.identity.films} films, sizes ${report.identity.sizes.join(', ')}.`,'',
  '| size | valid | calls | bodyBytes | toolMs | genMs | rating diff p90 | prob diff p90 | threshold agreement | MAE | bias |','| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
 for(const r of report.perSize){const a=r.agreementToBaseline,t=r.truth;lines.push(`| ${r.groupSize} | ${f(r.validShare)} | ${r.cost.mcpCalls} | ${f(r.cost.bodyBytes.total)} | ${f(r.cost.toolMs)} | ${f(r.cost.generationMs)} | ${f(a?.predictedRatingAbsDiff.p90)} | ${f(a?.probability4PlusAbsDiff.p90)} | ${f(a?.threshold4Agreement)} | ${f(t?.mae)} | ${f(t?.bias)} |`);}
 lines.push('',`Ground truth: ${report.quality.truth.available?report.quality.truth.films+' films of hidden user ratings (never given to the generator)':'none. Only agreement to the size-1 baseline is reported, and a model prediction is not ground truth'}.`,'',`Unknown or unavailable: ${report.unknown.length?report.unknown.join(', '):'none'}.`,'');
 return lines.join('\n');
}

function main(argv){
 const args={results:[],truth:null,out:null,markdown:null};
 for(let i=0;i<argv.length;i++){const a=argv[i];if(a==='--results'){while(argv[i+1]&&!argv[i+1].startsWith('--'))args.results.push(argv[++i]);}else if(a==='--truth')args.truth=argv[++i];else if(a==='--out')args.out=argv[++i];else if(a==='--markdown')args.markdown=argv[++i];else throw new AbReportError('usage','unknown argument');}
 const files=args.results.flatMap(p=>fs.statSync(p).isDirectory()?fs.readdirSync(p).filter(n=>n.endsWith('.json')).map(n=>path.join(p,n)):[p]);
 const results=files.map(p=>JSON.parse(fs.readFileSync(p,'utf8')));
 const truth=args.truth?JSON.parse(fs.readFileSync(args.truth,'utf8')):null;
 const report=buildReport(results,{truth});
 const text=JSON.stringify(report,null,1)+'\n';
 if(args.out)fs.writeFileSync(args.out,text);else process.stdout.write(text);
 if(args.markdown)fs.writeFileSync(args.markdown,renderMarkdown(report));
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)){
 try{main(process.argv.slice(2));}catch(e){process.stderr.write((e.code||'error')+': '+e.message+'\n');process.exit(1);}
}
