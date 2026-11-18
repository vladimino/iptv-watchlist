#!/usr/bin/env node
// AIR-476: offline A/B harness for the evidence-aware scoring candidate (owner GO 18 Nov 2026, offline model calls only).
// It builds the 24 isolated generator prompts (4 synthetic cases x base/candidate x 3 replicates) from the repository
// texts, and grades the collected raw outputs with scripts/prediction-scoring-rubric.mjs. It calls no model itself, no
// network, no IPTV MCP, no Scheduled Task and no production storage. The generator calls are made outside this script,
// one fresh context per prompt, and their raw answers are saved as <runId>.json next to the prompts.
//
// The production prompt cannot run offline literally (it drives the IPTV MCP batch protocol and web search). The adapter
// below is symmetric: both variants get the same preamble, the same output contract and the same verbatim scoring steps
// 3а, 3б, 4, 5 and 6 of the installed prompt; the candidate adds only its verbatim step 6а. Steps 1-3, 3в, 3г, 7-11 are
// orchestration, audit and reporting and are omitted from both. This is adapter parity, not literal prompt parity.
//
// Usage:
//   node scripts/prediction-scoring-ab-harness.mjs build <outDir> [--candidate v1|v2]   writes manifest.json and prompts/<runId>.txt
//   node scripts/prediction-scoring-ab-harness.mjs grade <outDir>   reads raw/<runId>.json, writes graded.json, prints aggregates
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {evaluate,loadFixtures,list} from './prediction-scoring-rubric.mjs';

const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=t=>createHash('sha256').update(t).digest('hex');
const block=(doc,name)=>{const m=doc.match(new RegExp('---BEGIN '+name+'---\\n([\\s\\S]*?)\\n---END '+name+'---'));if(!m)throw new Error(name+' markers missing');return m[1];};
export const BASE_SHA='1192b92c3d50a2478afd27b06b2d055972375497374e237ef212b6b6e5e2c95c';
// Candidate versions. v1 is the historical text of the first A/B (seed 476, method fingerprint 7647d808…) and stays
// reproducible; v2 (positive-only matchSignals) is the latest pending candidate and the default.
export const CANDIDATES={
 v1:{file:'docs/evidence/prediction/air-476-evidence-aware-scoring-candidate-2026-11-17.md',sha:'1826af6f11eb3aad6d3f2dd4c40542b93d0040e46d316cd3d9bf30168c4ee2c1',seed:476},
 v2:{file:'docs/evidence/prediction/air-476-evidence-aware-scoring-candidate-v2-2026-11-18.md',sha:'ccfd5c1cbeb43cfe5b6fba0b173f880d31237eeb04e9dde6d2552e1f000da520',seed:4762},
};
export const LATEST_CANDIDATE='v2';
export const CANDIDATE_SHA=CANDIDATES[LATEST_CANDIDATE].sha;
export const REPLICATES=3;
export const SEED=CANDIDATES[LATEST_CANDIDATE].seed;

export function promptTexts(version=LATEST_CANDIDATE){
 const spec=CANDIDATES[version];if(!spec)throw new Error('unknown candidate version '+version);
 const base=block(fs.readFileSync(path.join(root,'docs/reference/scheduled-task-prompts/hourly-predictions-batch-v2.md'),'utf8'),'PROMPT');
 const candidate=block(fs.readFileSync(path.join(root,spec.file),'utf8'),'CANDIDATE PROMPT');
 if(sha(base)!==BASE_SHA)throw new Error('base prompt drifted from '+BASE_SHA);
 if(sha(candidate)!==spec.sha)throw new Error('candidate '+version+' drifted from '+spec.sha);
 const pick=(text,prefixes)=>prefixes.map(p=>{const line=text.split('\n').find(l=>l.startsWith(p));if(!line)throw new Error('missing step '+p);return line;});
 const shared=['3а. ','3б. ','4. ','5. ','6. '];
 return {base:pick(base,shared),candidate:pick(candidate,[...shared,'6а. '])};
}

export const PREAMBLE=`OFFLINE ОЦЕНКА ОДНОГО ФИЛЬМА (изолированный эксперимент, не production).
У тебя НЕТ IPTV MCP, web search, файлов и других инструментов; не пытайся их использовать и не вызывай prediction_batch_*, enrichment_* или иные вызовы. Шаги 1–3, 3в, 3г и 7–11 production-процесса здесь не выполняются.
Соответствие: manifest.profile.body = PROFILE ниже; manifest.films[].modelMetadata = METADATA ниже; plan = PLAN ниже; для plan=prediction_only существующий fingerprint = FINGERPRINT ниже.
Исследование: RESEARCH_CORPUS ниже — ПОЛНЫЙ результат твоих двух разрешённых web search запросов для этого фильма. Запись с access=search_snippet — только фрагмент поисковой выдачи, страница не открыта. Запись full_text/partial_text — реально прочитанный текст в указанном объёме. Других URL, рецензий или чтений нет; пустой корпус означает, что поиск не дал пригодного результата. Источники web_research ссылаются только на URL из корпуса.
Ниже дословно правила оценки production prompt; применяй их к этому одному фильму.`;

export const CONTRACT=`ФОРМАТ ОТВЕТА: ровно один JSON-объект без markdown и пояснений:
{"fingerprint": {...} (ТОЛЬКО при plan=fingerprint_and_prediction; при prediction_only ключа нет), "prediction": {"predictedRating": полу-шаг 0.5–5, "probability4Plus": 0–1, "confidence": "low"|"medium"|"high", "matchSignals": до 3 строк, "mainRisk": строка, "moodLabels": 2–4 русских строки}, "assessment": {объект шага 3а}}
fingerprint (если нужен): {"fingerprintSchemaVersion":1, "plotMechanics":[id механик, например heist_scam, investigation_mystery, chase_escape, escort_rescue, siege_survival, ticking_clock, expedition, plan_counterplan], "execution":{13 general dimensions шага 5 со значением: конкретное короткое значение (например strong, solid, mixed, weak, high, low) либо "unknown" или "not_applicable"; опционально жанровые}, "evidence":{"plotMechanics":{id:[items]}, "execution":{dimension:[items]}} по шагу 5}.
Если честный прогноз невозможен, верни {"failure":{"kind":"parse_error","reason":"insufficient_evidence"}} — без выдуманных данных.`;

export function buildPrompt(variant,film,profile,version=LATEST_CANDIDATE){
 const steps=promptTexts(version)[variant];
 return [PREAMBLE,'',...steps,'',CONTRACT,'','PROFILE:',profile.body,'','PLAN: '+film.plan,'METADATA: '+JSON.stringify(film.modelMetadata),...(film.fingerprint?['FINGERPRINT: '+JSON.stringify(film.fingerprint)]:[]),'RESEARCH_CORPUS: '+JSON.stringify(film.researchCorpus)].join('\n');
}

// Deterministic Fisher-Yates with a small LCG so the run order is reproducible from SEED.
function shuffle(list,seed){let s=seed>>>0;const rnd=()=>((s=(Math.imul(s,1664525)+1013904223)>>>0)/2**32);const a=[...list];for(let i=a.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}

export function plan(version=LATEST_CANDIDATE){
 const {inputs}=loadFixtures(),texts=promptTexts(version),{sha:candidateSha,seed}=CANDIDATES[version];
 const methodFingerprint=sha(JSON.stringify({PREAMBLE,CONTRACT,base:texts.base,candidate:texts.candidate,inputs:sha(JSON.stringify(inputs))}));
 const runs=[];
 for(const film of inputs.films)for(const variant of ['base','candidate'])for(let replicate=1;replicate<=REPLICATES;replicate++)runs.push({caseId:film.caseId,variant,replicate});
 const ordered=shuffle(runs,seed).map((r,i)=>({order:i+1,runId:`r${String(i+1).padStart(2,'0')}-${r.caseId}-${r.variant}-${r.replicate}`,...r}));
 return {fixtureVersion:inputs.fixtureVersion,baseSha:BASE_SHA,candidateVersion:version,candidateSha,seed,methodFingerprint,runs:ordered.map(r=>{const film=inputs.films.find(f=>f.caseId===r.caseId),prompt=buildPrompt(r.variant,film,inputs.profile,version);return {...r,promptSha256:sha(prompt),promptChars:prompt.length,prompt};})};
}

function parseRaw(text){
 const t=String(text).trim().replace(/^```(?:json)?\s*/,'').replace(/```\s*$/,'');
 const start=t.indexOf('{'),end=t.lastIndexOf('}');
 try{return JSON.parse(t.slice(start,end+1));}catch{return null;}
}

export function grade(manifest,rawByRun){
 const rows=[];
 for(const r of manifest.runs){
  const rec=rawByRun[r.runId];
  const parsed=rec?parseRaw(rec.answer):null;
  const output=parsed&&!parsed.failure?{caseId:r.caseId,...parsed}:null;
  const res=output?evaluate([output]):null;
  const checks=res?res.cases.find(c=>c.caseId===r.caseId).checks:[{id:'output_parsed',status:'fail',detail:rec?(parsed?.failure?'generator returned failure '+JSON.stringify(parsed.failure):'unparseable answer'):'missing answer'}];
  const p=output?.prediction||{},a=output?.assessment||{};
  rows.push({runId:r.runId,caseId:r.caseId,variant:r.variant,replicate:r.replicate,toolUses:rec?.toolUses??null,predictedRating:p.predictedRating??null,probability4Plus:p.probability4Plus??null,confidence:p.confidence??null,researchStatus:a.research?.status??null,webSources:list(a.sources).filter(s=>s?.kind==='web_research').map(s=>s.access),against:list(a.tasteSignals).filter(s=>s?.direction==='against').length,supports:list(a.tasteSignals).filter(s=>s?.direction==='supports').length,highRisks:list(a.risks).filter(x=>x?.severity==='high').length,uncertainties:list(a.uncertainties).length,checks:checks.map(c=>({id:c.id,status:c.status}))});
 }
 return rows;
}

export function aggregate(rows){
 const out={};
 for(const row of rows){
  const k=`${row.caseId}/${row.variant}`,g=out[k]||(out[k]={caseId:row.caseId,variant:row.variant,n:0,ratings:[],p4:[],confidence:{},fail:0,flag:0,failIds:{},flagIds:{}});
  g.n++;g.ratings.push(row.predictedRating);g.p4.push(row.probability4Plus);g.confidence[row.confidence]=(g.confidence[row.confidence]||0)+1;
  for(const c of row.checks){if(c.status==='fail'){g.fail++;g.failIds[c.id]=(g.failIds[c.id]||0)+1;}if(c.status==='flag'){g.flag++;g.flagIds[c.id]=(g.flagIds[c.id]||0)+1;}}
 }
 return Object.values(out).sort((a,b)=>a.caseId.localeCompare(b.caseId)||a.variant.localeCompare(b.variant));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [cmd,dir,...rest]=process.argv.slice(2);const ci=rest.indexOf('--candidate'),version=ci>=0?rest[ci+1]:LATEST_CANDIDATE;
 if(!dir||!['build','grade'].includes(cmd)){console.error('usage: build|grade <outDir>');process.exit(2);}
 if(cmd==='build'){
  const m=plan(version);fs.mkdirSync(path.join(dir,'prompts'),{recursive:true});
  for(const r of m.runs)fs.writeFileSync(path.join(dir,'prompts',r.runId+'.txt'),r.prompt);
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({...m,runs:m.runs.map(({prompt,...r})=>r)},null,1));
  console.log(JSON.stringify({methodFingerprint:m.methodFingerprint,runs:m.runs.length},null,1));
 }else{
  const m=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8')),raw={};
  for(const r of m.runs){const f=path.join(dir,'raw',r.runId+'.json');if(fs.existsSync(f))raw[r.runId]=JSON.parse(fs.readFileSync(f,'utf8'));}
  const rows=grade(m,raw);fs.writeFileSync(path.join(dir,'graded.json'),JSON.stringify(rows,null,1));
  console.log(JSON.stringify(aggregate(rows),null,1));
 }
}
