#!/usr/bin/env node
// AIR-450: offline aggregator of the batch runner v2 dry-run A/B (generation size 1 to 10). It reads the PRIVATE per-pass result records (`$defs.result` of
// docs/reference/scheduled-task-prompts/batch-v2-ab.schema.json) and an optional PRIVATE truth file, and writes a SANITIZED report.
// Privacy by construction: (1) every input record is validated against the closed input schema first and refused otherwise, with an error that names paths and keywords only, never a value;
// (2) the report is built field by field from numbers, enums, hex hashes and film ids, never by copying an input object or string; (3) the finished report is validated against the closed `$defs.report`
// schema before it is returned. It never prints a fingerprint, a prediction, metadata, a model name taken from a record or any free text, and it never touches production, a model or the network.
// Usage: node scripts/prediction-ab-report.mjs --results <dir|file...> [--truth <file.json>] [--model-label <label>] [--out <report.json>] [--markdown <report.md>]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {check} from './json-schema-lite.mjs';

const SCHEMA=JSON.parse(fs.readFileSync(new URL('../docs/reference/scheduled-task-prompts/batch-v2-ab.schema.json',import.meta.url),'utf8'));
const BASELINE=1,THRESHOLD=4,SIZES=[1,2,3,4,5,6,7,8,9,10],EXPECTED_FILMS=100;
const FAILURE_REASONS=['insufficient_metadata','insufficient_knowledge','json_unparseable','other','unspecified'];
const STATUSES=['would_write','already_current','not_eligible','validation_failure','not_submitted'];
const sum=a=>a.reduce((x,y)=>x+y,0),mean=a=>a.length?sum(a)/a.length:null;
const round=(x,d=4)=>x===null||x===undefined||!Number.isFinite(x)?null:Math.round(x*10**d)/10**d;
const quantile=(a,q)=>{if(!a.length)return null;const s=[...a].sort((x,y)=>x-y),i=(s.length-1)*q,lo=Math.floor(i),hi=Math.ceil(i);return s[lo]+(s[hi]-s[lo])*(i-lo);};
const dist=a=>({n:a.length,mean:round(mean(a)),median:round(quantile(a,.5)),p90:round(quantile(a,.9)),max:round(a.length?Math.max(...a):null)});
const tokens=text=>new Set(String(text||'').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t=>t.length>2));
const jaccard=(a,b)=>{if(!a.size&&!b.size)return 1;let i=0;for(const x of a)if(b.has(x))i++;return i/(a.size+b.size-i);};
const signalTokens=p=>tokens([].concat(Array.isArray(p?.matchSignals)?p.matchSignals.filter(x=>typeof x==='string'):[]).join(' '));

export class AbReportError extends Error{constructor(code,detail){super(code+(detail?': '+detail:''));this.code=code;}}
// Error texts never carry a value: the checker's messages are cut to path and keyword (the name of an unexpected key is dropped too).
const safeErrors=errors=>[...new Set(errors.map(e=>e.replace(/ extra .*$/,' extra').replace(/ type \S+$/,' type')))].slice(0,5).join('; ');

// 1. Strict validation of every private input record against the closed input schema (a defect in a record is a refusal, not a silent copy).
export function validateResult(record){
 const errors=check(SCHEMA.$defs.result,record);
 if(errors.length)throw new AbReportError('invalid_input',safeErrors(errors));
 for(const f of record.films){
  if(f.prediction!==null&&f.prediction!==undefined){const p=f.prediction;if(typeof p!=='object'||Array.isArray(p))throw new AbReportError('invalid_input','prediction');
   if(p.predictedRating!==undefined&&!(Number.isFinite(p.predictedRating)&&p.predictedRating>=0.5&&p.predictedRating<=5&&Number.isInteger(p.predictedRating*2)))throw new AbReportError('invalid_input','predictedRating');
   if(p.probability4Plus!==undefined&&!(Number.isFinite(p.probability4Plus)&&p.probability4Plus>=0&&p.probability4Plus<=1))throw new AbReportError('invalid_input','probability4Plus');}
 }
 return record;
}

// Fail closed: every pass must be the same experiment (one frozen manifest, one sample, the same films in the same order) and each group size appears once.
export function checkPasses(results){
 if(!Array.isArray(results)||!results.length)throw new AbReportError('no_results');
 results.forEach(validateResult);
 const first=results[0],sizes=new Set();
 for(const r of results){
  if(r.sampleId!==first.sampleId)throw new AbReportError('sample_mismatch');
  if(r.manifestHash!==first.manifestHash)throw new AbReportError('manifest_mismatch','a pass used another manifest: discard and rerun it');
  if(JSON.stringify(r.profile)!==JSON.stringify(first.profile)||JSON.stringify(r.contract)!==JSON.stringify(first.contract))throw new AbReportError('identity_mismatch');
  if(sizes.has(r.groupSize))throw new AbReportError('duplicate_size');
  sizes.add(r.groupSize);
  if(JSON.stringify(r.films.map(f=>f.filmId))!==JSON.stringify(first.films.map(f=>f.filmId)))throw new AbReportError('film_set_mismatch','the same films in the same order are required in every pass');
  if(r.calls.some(c=>c.itemCount>r.groupSize))throw new AbReportError('group_size_exceeded');
  // Explicit association: films point to the call that recorded them by callId, never by array position. Anything ambiguous is refused.
  const callById=new Map(r.calls.map(c=>[c.callId,c]));
  if(callById.size!==r.calls.length)throw new AbReportError('call_mapping','duplicate callId');
  const refs=new Map();
  r.films.forEach((f,i)=>{
   if(f.groupIndex!==Math.floor(i/r.groupSize))throw new AbReportError('group_mapping','groupIndex differs from the frozen grouping');
   if(f.submitStatus==='not_submitted'){if(f.callId!==null)throw new AbReportError('call_mapping','a not_submitted film names a call');return;}
   const c=callById.get(f.callId);
   if(!c||c.groupIndex!==f.groupIndex)throw new AbReportError('call_mapping','a film names a missing call or a call of another group');
   if((c.kind??'submit')!=='submit')throw new AbReportError('call_mapping','a film names a preflight call: its result is recorded by a submit call');
   refs.set(f.callId,(refs.get(f.callId)||0)+1);
  });
  for(const [id,n] of refs)if(n>callById.get(id).itemCount)throw new AbReportError('call_mapping','a call holds fewer items than films name it');
 }
 return [...sizes].sort((a,b)=>a-b);
}

// A film is comparable only when the Worker would write it, its live input is still the frozen manifest's, and the live profile never moved under its call.
const validStatus=f=>f.submitStatus==='would_write'||f.submitStatus==='already_current';
const rating=f=>f.prediction&&Number.isFinite(f.prediction.predictedRating)?f.prediction.predictedRating:null;
const prob=f=>f.prediction&&Number.isFinite(f.prediction.probability4Plus)?f.prediction.probability4Plus:null;
const int=x=>Number.isInteger(x)?x:null;

// Preflight outcome per film (prediction_batch_validate): counts only. A film is invalid at its first attempt when it needed a second attempt or never became valid.
// Assessment counts per pass (ADR 0132): presence, size and research outcome only; no text, no URL.
const assessmentCounts=films=>{const a=films.map(f=>f.assessment).filter(x=>x&&x.sent),b=a.map(x=>x.bytes).filter(Number.isInteger);return {sent:a.length,withWebSources:a.filter(x=>x.webSources>0).length,snippetOnly:a.filter(x=>x.webSources>0&&x.snippetOnlyWebSources===x.webSources).length,withConflicts:a.filter(x=>x.conflicts>0).length,researchFound:a.filter(x=>x.researchStatus==='attempted_found').length,researchBlocked:a.filter(x=>x.researchStatus==='attempted_blocked').length,bytesMax:b.length?Math.max(...b):null,bytesMean:b.length?round(b.reduce((x,y)=>x+y,0)/b.length):null};};

const preflightCounts=films=>{const p=films.filter(f=>f.preflight);return {checked:p.length,invalidFirst:p.filter(f=>f.preflight.attempts>1||!f.preflight.valid).length,recovered:p.filter(f=>f.preflight.attempts>1&&f.preflight.valid).length,unresolved:p.filter(f=>!f.preflight.valid).length};};

export function buildReport(results,{truth=null,modelLabel=null}={}){
 const sizes=checkPasses(results),by=new Map(results.map(r=>[r.groupSize,r])),first=results[0];
 if(modelLabel!==null&&!/^[A-Za-z0-9._-]{1,40}$/.test(modelLabel))throw new AbReportError('invalid_model_label');
 const manifestProfile=first.profile.hash;
 const filmIds=first.films.map(f=>f.filmId);
 const truthIds=truth&&typeof truth==='object'?new Set(Object.keys(truth).filter(id=>filmIds.includes(id)&&Number.isFinite(truth[id]))):new Set();
 // per pass: which films are comparable. A call whose observed profile hash differs from the manifest's makes all its films stale; a pass that stopped for profile_moved leaves the rest not submitted.
 const comparable=new Map(),detail=new Map();
 for(const r of results){
  const stale=new Set(),callOf=new Map(r.calls.map(c=>[c.callId,c])),used=new Set();
  for(const f of r.films){if(f.submitStatus==='not_submitted')continue;const c=callOf.get(f.callId);used.add(f.callId);if(!c||c.observedProfileHash===null||c.observedProfileHash!==manifestProfile)stale.add(f.filmId);}
  const changed=r.films.filter(f=>validStatus(f)&&f.liveInput!=='same'&&!stale.has(f.filmId)).length;
  const set=new Set(r.films.filter(f=>validStatus(f)&&f.liveInput==='same'&&!stale.has(f.filmId)).map(f=>f.filmId));
  comparable.set(r.groupSize,set);detail.set(r.groupSize,{stale:stale.size,changed,mismatchCalls:r.calls.filter(c=>used.has(c.callId)&&(c.observedProfileHash===null||c.observedProfileHash!==manifestProfile)).length});
 }
 const baseline=by.get(BASELINE)||null,missing=SIZES.filter(s=>!by.has(s));
 const report={schemaVersion:1,kind:'prediction_batch_v2_ab_report',
  identity:{sampleId:first.sampleId,manifestHash:first.manifestHash,profile:{version:first.profile.version,hash:first.profile.hash},contract:{fingerprintSchemaVersion:first.contract.fingerprintSchemaVersion,fingerprintPromptVersion:first.contract.fingerprintPromptVersion,predictionPromptVersion:first.contract.predictionPromptVersion,registryDigest:first.contract.registryDigest},films:filmIds.length,sizes,baselineSize:baseline?BASELINE:null},
  completeness:{allSizes:missing.length===0,missingSizes:missing,films:filmIds.length,final:missing.length===0&&filmIds.length===EXPECTED_FILMS,ownerAcceptance:'required'},
  quality:{truth:{available:truthIds.size>0,films:truthIds.size,basis:truthIds.size?'hidden_user_ratings':'agreement_to_baseline_only'}},
  perSize:[],stability:null,unknown:[],model:modelLabel};
 const unknown=new Set();
 for(const size of sizes){
  const r=by.get(size),films=r.films,ok=comparable.get(size),okFilms=films.filter(f=>ok.has(f.filmId)),d=detail.get(size);
  const statuses=Object.fromEntries(STATUSES.map(s=>[s,0]));for(const f of films)statuses[f.submitStatus]++;
  const allOf=a=>a.length>0&&a.every(x=>Number.isFinite(x));
  const bodyBytes=r.calls.map(c=>c.bodyBytes),toolMs=r.calls.map(c=>c.toolMs),genMs=films.map(f=>f.generationMs);
  const unavailable=SCHEMA.$defs.result.properties.telemetry.properties.unavailable.items.enum.filter(k=>(r.telemetry.unavailable||[]).includes(k));
  const t=r.telemetry,tok=t.tokens,q=t.quota;
  const row={groupSize:size,films:films.length,statuses,comparableFilms:okFilms.length,
   excluded:{liveInputChanged:d.changed,staleProfile:d.stale,notValid:films.filter(f=>!validStatus(f)).length},
   preflight:preflightCounts(films),assessment:assessmentCounts(films),
   failureReasons:Object.fromEntries(FAILURE_REASONS.map(k=>[k,films.filter(f=>f.submitStatus==='validation_failure'&&(f.failureReason||'unspecified')===k).length])),
   validShare:round(okFilms.length/films.length),sizeRefusals:r.calls.filter(c=>!c.ok).length,profileMismatchCalls:d.mismatchCalls,stoppedReason:r.stoppedReason??null,
   cost:{mcpCalls:r.calls.length,preflightCalls:r.calls.filter(c=>c.kind==='preflight').length,bodyBytes:{total:allOf(bodyBytes)?sum(bodyBytes):null,max:allOf(bodyBytes)?Math.max(...bodyBytes):null},toolMs:allOf(toolMs)?sum(toolMs):null,generationMs:allOf(genMs)?sum(genMs):null,wallMs:int(t.wallMs),
    tokens:tok?{input:int(tok.input),output:int(tok.output)}:null,quota:q?{remainingPercentBefore:Number.isFinite(q.remainingPercentBefore)?q.remainingPercentBefore:null,remainingPercentAfter:Number.isFinite(q.remainingPercentAfter)?q.remainingPercentAfter:null}:null,unavailable}};
  if(d.stale||d.mismatchCalls)unknown.add('profile_moved');
  for(const k of unavailable)unknown.add('telemetry_'+k);
  if(truthIds.size){
   const rows=okFilms.filter(f=>truthIds.has(f.filmId)&&rating(f)!==null),err=rows.map(f=>rating(f)-truth[f.filmId]);
   row.truth={n:rows.length,mae:round(mean(err.map(Math.abs))),bias:round(mean(err)),threshold4Accuracy:rows.length?round(rows.filter(f=>(rating(f)>=THRESHOLD)===(truth[f.filmId]>=THRESHOLD)).length/rows.length):null};
  }
  if(baseline&&size!==BASELINE){
   const bOk=comparable.get(BASELINE),base=new Map(baseline.films.filter(f=>bOk.has(f.filmId)).map(f=>[f.filmId,f])),pairs=okFilms.filter(f=>base.has(f.filmId)).map(f=>[base.get(f.filmId),f]);
   const dr=pairs.filter(([a,b])=>rating(a)!==null&&rating(b)!==null).map(([a,b])=>Math.abs(rating(a)-rating(b)));
   const dp=pairs.filter(([a,b])=>prob(a)!==null&&prob(b)!==null).map(([a,b])=>Math.abs(prob(a)-prob(b)));
   const execKeys=([a,b])=>{const ea=a.fingerprint?.execution,eb=b.fingerprint?.execution;if(!ea||!eb||typeof ea!=='object')return null;const ks=Object.keys(ea);return ks.length?ks.filter(k=>ea[k]===eb[k]).length/ks.length:null;};
   const mech=([a,b])=>a.fingerprint&&b.fingerprint&&Array.isArray(a.fingerprint.plotMechanics)&&Array.isArray(b.fingerprint.plotMechanics)?jaccard(new Set(a.fingerprint.plotMechanics),new Set(b.fingerprint.plotMechanics)):null;
   const execA=pairs.map(execKeys).filter(x=>x!==null),mechA=pairs.map(mech).filter(x=>x!==null);
   row.agreementToBaseline={pairs:pairs.length,predictedRatingAbsDiff:dist(dr),probability4PlusAbsDiff:dist(dp),
    confidenceAgreement:pairs.length?round(pairs.filter(([a,b])=>a.prediction?.confidence===b.prediction?.confidence).length/pairs.length):null,
    threshold4Agreement:dr.length?round(pairs.filter(([a,b])=>rating(a)!==null&&rating(b)!==null&&(rating(a)>=THRESHOLD)===(rating(b)>=THRESHOLD)).length/dr.length):null,
    matchSignalsOverlap:dist(pairs.map(([a,b])=>jaccard(signalTokens(a.prediction),signalTokens(b.prediction)))),
    mainRiskOverlap:dist(pairs.map(([a,b])=>jaccard(tokens(a.prediction?.mainRisk),tokens(b.prediction?.mainRisk)))),
    executionAgreement:execA.length?dist(execA):null,plotMechanicsOverlap:mechA.length?dist(mechA):null,fingerprintPairs:execA.length};
  }
  report.perSize.push(row);
 }
 const spreads=[],probSpreads=[];
 for(const id of filmIds){
  const rs=sizes.map(s=>comparable.get(s).has(id)?by.get(s).films.find(f=>f.filmId===id):null).filter(Boolean),r=rs.map(rating).filter(x=>x!==null),p=rs.map(prob).filter(x=>x!==null);
  if(r.length>=2)spreads.push(Math.max(...r)-Math.min(...r));if(p.length>=2)probSpreads.push(Math.max(...p)-Math.min(...p));
 }
 report.stability={predictedRatingSpread:dist(spreads),probability4PlusSpread:dist(probSpreads)};
 if(!baseline)unknown.add('no_size_1_baseline');if(!truthIds.size)unknown.add('no_ground_truth');if(missing.length)unknown.add('partial_sizes');if(filmIds.length!==EXPECTED_FILMS)unknown.add('partial_films');
 report.unknown=[...unknown].sort();
 assertSanitized(report);
 return report;
}

// Closed-schema gate: the finished report must be exactly the closed `$defs.report`, so a field the builder did not whitelist cannot be emitted. A key blacklist stays as a second guard.
const FORBIDDEN_KEYS=/^(fingerprint|prediction|matchSignals|mainRisk|moodLabels|synopsis|title|original|metadata|modelMetadata|profileBody|body|evidence|execution|plotMechanics|notes|error|issues|path|code)$/;
export function assertSanitized(value,where='$'){
 const errors=check(SCHEMA.$defs.report,value);if(errors.length)throw new AbReportError('unsanitized_report',safeErrors(errors));
 (function walk(v){if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')for(const [k,x] of Object.entries(v)){if(FORBIDDEN_KEYS.test(k))throw new AbReportError('forbidden_key',where);walk(x);}})(value);
}

export function renderMarkdown(report){
 const f=x=>x===null||x===undefined?'n/a':String(x);
 const lines=['# Batch runner v2 dry-run A/B report','',report.completeness.final?'Complete comparison of all ten sizes; the owner still accepts it.':`**PARTIAL DIAGNOSTIC, not the final AIR-450 comparison** (missing sizes: ${report.completeness.missingSizes.join(', ')||'none'}; films: ${report.completeness.films}). Owner acceptance is required.`,'',
  `Sample \`${report.identity.sampleId}\`, manifest \`${report.identity.manifestHash}\`, ${report.identity.films} films, sizes ${report.identity.sizes.join(', ')}${report.model?', model '+report.model:''}.`,'',
  '| size | comparable | excluded (changed/stale/invalid) | calls | bodyBytes | toolMs | genMs | rating diff p90 | prob diff p90 | threshold agreement | MAE | bias |','| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
 for(const r of report.perSize){const a=r.agreementToBaseline,t=r.truth,e=r.excluded;lines.push(`| ${r.groupSize} | ${r.comparableFilms}/${r.films} | ${e.liveInputChanged}/${e.staleProfile}/${e.notValid} | ${r.cost.mcpCalls} | ${f(r.cost.bodyBytes.total)} | ${f(r.cost.toolMs)} | ${f(r.cost.generationMs)} | ${f(a?.predictedRatingAbsDiff.p90)} | ${f(a?.probability4PlusAbsDiff.p90)} | ${f(a?.threshold4Agreement)} | ${f(t?.mae)} | ${f(t?.bias)} |`);}
 lines.push('',`Ground truth: ${report.quality.truth.available?report.quality.truth.films+' films of hidden user ratings (never given to the generator)':'none. Only agreement to the size-1 baseline is reported, and a model prediction is not ground truth'}.`,'',`Unknown or unavailable: ${report.unknown.length?report.unknown.join(', '):'none'}.`,'');
 return lines.join('\n');
}

function main(argv){
 const args={results:[],truth:null,out:null,markdown:null,modelLabel:null};
 for(let i=0;i<argv.length;i++){const a=argv[i];if(a==='--results'){while(argv[i+1]&&!argv[i+1].startsWith('--'))args.results.push(argv[++i]);}else if(a==='--truth')args.truth=argv[++i];else if(a==='--out')args.out=argv[++i];else if(a==='--markdown')args.markdown=argv[++i];else if(a==='--model-label')args.modelLabel=argv[++i];else throw new AbReportError('usage');}
 const files=args.results.flatMap(p=>fs.statSync(p).isDirectory()?fs.readdirSync(p).filter(n=>n.endsWith('.json')).map(n=>path.join(p,n)):[p]);
 // a parse error names the file, never the content (a JSON.parse message can quote the source)
 const read=p=>{try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch{throw new AbReportError('invalid_json',path.basename(p));}};
 const results=files.map(read),truth=args.truth?read(args.truth):null;
 const report=buildReport(results,{truth,modelLabel:args.modelLabel});
 const text=JSON.stringify(report,null,1)+'\n';
 if(args.out)fs.writeFileSync(args.out,text);else process.stdout.write(text);
 if(args.markdown)fs.writeFileSync(args.markdown,renderMarkdown(report));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{main(process.argv.slice(2));}catch(e){process.stderr.write((e instanceof AbReportError?e.code+(e.message.includes(': ')?': '+e.message.split(': ').slice(1).join(': '):''):'error')+'\n');process.exit(1);}
}
