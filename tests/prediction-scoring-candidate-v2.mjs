// AIR-476 candidate v2: positive-only matchSignals. Static checks only (no model, network, production or Scheduled Task):
// v2 differs from historical v1 by one insertion inside step 6а, and equals the frozen pre-install base plus exactly two lines,
// keeps the batch v2 invariants, and the grader's matchSignals checks behave on synthetic outputs.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {evaluate,loadFixtures} from '../scripts/prediction-scoring-rubric.mjs';
import {CANDIDATES,LATEST_CANDIDATE,plan,promptTexts,grade} from '../scripts/prediction-scoring-ab-harness.mjs';

const sha=t=>createHash('sha256').update(t).digest('hex');
const block=(doc,name)=>{const m=doc.match(new RegExp('---BEGIN '+name+'---\\n([\\s\\S]*?)\\n---END '+name+'---'));assert.ok(m,name);return m[1];};
const canonical=fs.readFileSync('docs/reference/scheduled-task-prompts/hourly-predictions-batch-v2.md','utf8');
const historical=fs.readFileSync('docs/evidence/prediction/air-476-preinstall-baseline-2026-11-17.md','utf8');
const base=block(historical,'PROMPT'),installed=block(canonical,'PROMPT'),dry=block(canonical,'DRY RUN PROMPT');
const v1Doc=fs.readFileSync(CANDIDATES.v1.file,'utf8'),v2Doc=fs.readFileSync(CANDIDATES.v2.file,'utf8');
const v1=block(v1Doc,'CANDIDATE PROMPT'),v2=block(v2Doc,'CANDIDATE PROMPT');

// 1. Hashes and the latest-pending pointer.
assert.equal(LATEST_CANDIDATE,'v2');
assert.equal(sha(base),'1192b92c3d50a2478afd27b06b2d055972375497374e237ef212b6b6e5e2c95c','frozen historical baseline unchanged');
assert.equal(sha(v1),CANDIDATES.v1.sha,'v1 historical candidate unchanged');
assert.equal(sha(v2),CANDIDATES.v2.sha);assert.equal(v2.length,45938);assert.equal(Buffer.byteLength(v2,'utf8'),69379);
assert.ok(/\| 45938 \| 69379 \| `ccfd5c1cbeb43cfe5b6fba0b173f880d31237eeb04e9dde6d2552e1f000da520` \|/.test(v2Doc));
assert.ok(/Status: accepted and installed/.test(v2Doc));
assert.equal(sha(installed),CANDIDATES.v2.sha,'installed canonical must be approved candidate v2');
assert.equal(installed,v2,'canonical prompt must match the frozen v2 candidate byte for byte');
assert.ok(!base.includes('EVIDENCE-AWARE'),'historical baseline has no scoring overlay');
assert.ok(fs.readFileSync('docs/reference/scheduled-tasks.md','utf8').includes('air-476-evidence-aware-scoring-candidate-v2-2026-11-18.md'),'candidate evidence remains linked from operational reference');

// 2. v1 -> v2: only step 6а changes, by one insertion before «Это не новый поиск:».
const L1=v1.split('\n'),L2=v2.split('\n');
assert.equal(L2.length,L1.length);
const changed=L1.map((l,i)=>l===L2[i]?null:i).filter(i=>i!==null);
assert.equal(changed.length,1);const i6a=changed[0];assert.ok(L1[i6a].startsWith('6а. ')&&L2[i6a].startsWith('6а. '));
const anchor=' Это не новый поиск:',[pre,post]=L1[i6a].split(anchor);
assert.ok(L2[i6a].startsWith(pre)&&L2[i6a].endsWith(anchor+post),'insertion only, before the anchor');
const inserted=L2[i6a].slice(pre.length,L2[i6a].length-(anchor+post).length);
assert.equal(inserted.length,773);assert.equal(L2[i6a].length,3659);
assert.ok(v2Doc.includes('> '+inserted.trim()),'the report quotes the exact inserted text');

// 3. v2 is still base + exactly two inserted lines; generation steps 3а/4/5/6 identical to base and frozen dry-run.
const B=base.split('\n'),ib6=B.findIndex(l=>l.startsWith('6. Вкус:')),ig=B.findIndex(l=>l.startsWith('**Причина gate:**'));
assert.deepEqual([...L2.slice(0,ib6+1),...L2.slice(ib6+2,ig+2),...L2.slice(ig+3)],B,'v2 = base + step 6а + one report line');
const steps=t=>t.split('\n').filter(l=>/^(?:[456]|3а)\. /.test(l));
assert.deepEqual(steps(v2),steps(base));assert.deepEqual(steps(v2),steps(dry));
for(const needle of ['manifestSize=5','generationSize=1','submitBatchSize=5','НЕ БОЛЕЕ 2 web search запросов на фильм и НЕ БОЛЕЕ 3 независимо написанных источников','prediction_batch_validate({items})','prediction_batch_hold({runId,epoch,items})','prediction_batch_submit({runId,epoch,items})'])assert.ok(v2.includes(needle),needle);

// 4. The new rule.
for(const needle of ['matchSignals — ТОЛЬКО обоснованные положительные попадания','пустой список допустим','не заполняй его ради количества','Нейтральные свойства, подтверждённые минусы, against-факты и неопределённость туда НЕ помещай','mainRisk, tasteSignals direction=against, risks и uncertainties','«ветераны»','сами по себе НЕ подтверждают компетентность','только как premise','не выдавай его за match'])assert.ok(inserted.includes(needle),'rule: '+needle);
for(const kept of ['unknown НИКОГДА не превращай в минус','нижнего порога predictedRating или P4+ нет','Не повышай оценку автоматически'])assert.ok(L2[i6a].includes(kept),'v1 rule kept: '+kept);
assert.ok(!/\b(?:AIR-\d+|ADR[ -]?\d+)\b/.test(inserted)&&!/(?:не ниже|минимум|не менее)\s*[0-9]/.test(inserted));

// 5. Harness: v2 by default with a new seed; v1 stays reproducible; no grader-only key in any prompt.
const p2=plan(),p1=plan('v1');
assert.equal(p2.candidateVersion,'v2');assert.equal(p2.seed,4762);assert.equal(p2.runs.length,24);
assert.equal(p1.methodFingerprint,'7647d808b063bdafe18ef87b533534ac22c4b911f8d05aca755d64d60561aa96','first A/B method fingerprint reproducible');
assert.notEqual(p2.methodFingerprint,p1.methodFingerprint);
assert.equal(promptTexts('v2').candidate[5],L2[i6a]);assert.deepEqual(promptTexts('v2').base,promptTexts('v1').base,'base variant unchanged between experiments');
for(const r of p2.runs)for(const leak of ['matchSignalSuspectPattern','keyUnknownPattern','confirmedMinus','grader-rubric'])assert.ok(!r.prompt.includes(leak),r.runId+' leaks '+leak);

// 6. Grader matchSignals checks on synthetic outputs.
const {inputs,rubric}=loadFixtures();
const s4={caseId:'s4',prediction:{predictedRating:2,probability4Plus:0.04,confidence:'medium',mainRisk:'команда расходится без причины',moodLabels:['a','b']},assessment:{research:{status:'attempted_found'},sources:[{kind:'web_research',ref:'https://reviews.example.org/below-deck-nine-1',access:'full_text',usedFor:'x'}],tasteSignals:[{direction:'against',signal:'план игнорирует вентиляцию'}],risks:[],uncertainties:['x']}};
const check=(o,id)=>evaluate([o],{inputs,rubric}).cases.find(c=>c.caseId===o.caseId).checks.find(c=>c.id===id)?.status;
assert.equal(check({...s4,prediction:{...s4.prediction,matchSignals:[]}},'match_signals_shape'),'pass','an empty list is valid');
assert.equal(check({...s4,prediction:{...s4.prediction,matchSignals:[]}},'match_signal_suspect'),'pass');
assert.equal(check({...s4,prediction:{...s4.prediction,matchSignals:['Premise: осада палубы от существа']}},'match_signal_suspect'),'pass','a premise-labelled match is not flagged');
for(const bad of ['Ветераны отряда игнорируют вентиляцию, показанную в первой сцене','Финал решён неподготовленной спасательной группой за кадром','Ветеранский отряд как потенциально компетентные герои','Хоррор с правилами угрозы — ценимый формат'])
 assert.equal(check({...s4,prediction:{...s4.prediction,matchSignals:[bad]}},'match_signal_suspect'),'flag','flagged: '+bad);
assert.equal(check({...s4,prediction:{...s4.prediction,matchSignals:['a','b','c','d']}},'match_signals_shape'),'fail','more than three fails');
assert.equal(check({...s4,prediction:{...s4.prediction,matchSignals:'x'}},'match_signals_shape'),'fail');
const s2={caseId:'s2',prediction:{predictedRating:3.5,probability4Plus:0.3,confidence:'low',mainRisk:'качество не подтверждено',moodLabels:['a','b']},assessment:{research:{status:'attempted_found'},sources:[{kind:'web_research',ref:'https://search.example.org/hollow-signal-snippet',access:'search_snippet',usedFor:'x'}],uncertainties:['x']}};
assert.equal(check({...s2,prediction:{...s2.prediction,matchSignals:['Гибрид хоррора и экшна, 101 минута — ожидаемо плотный темп']}},'match_signal_suspect'),'flag','s2 execution claim from nothing');
assert.equal(check({...s2,prediction:{...s2.prediction,matchSignals:['Premise: осада в башне — любимый siege/survival']}},'match_signal_suspect'),'pass');
const s3={caseId:'s3',prediction:{predictedRating:4.5,probability4Plus:0.75,confidence:'medium',mainRisk:'x',moodLabels:['a','b'],matchSignals:['Честные улики показаны до дедукции']},assessment:{research:{status:'attempted_found'},sources:[{kind:'web_research',ref:'https://reviews.example.org/glasshouse-inquest-1',access:'full_text',usedFor:'x'}],tasteSignals:[{direction:'supports',signal:'x'}]}};
assert.equal(check(s3,'match_signal_suspect'),'pass','a grounded positive on s3 is not flagged');
const review=evaluate([{...s4,prediction:{...s4.prediction,matchSignals:['Premise: осада']}}],{inputs,rubric}).cases.find(c=>c.caseId==='s4').checks.find(c=>c.id==='grounding_review');
assert.equal(review.status,'flag');assert.ok(/claims/.test(review.detail));

// 7. Preflight review 5951825430: malformed list fields from a fresh model never throw; each is graded per run.
const malformed=[
 ['matchSignals object',{matchSignals:{x:'y'}},{}],
 ['matchSignals number',{matchSignals:123},{}],
 ['matchSignals null',{matchSignals:null},{}],
 ['tasteSignals object, risks string, sources object, uncertainties number',{matchSignals:[]},{tasteSignals:{direction:'against'},risks:'high',sources:{kind:'web_research'},uncertainties:3}],
];
for(const caseId of ['s1','s2','s3','s4']){
 const run={runId:'m-'+caseId,caseId,variant:'candidate',replicate:1};
 for(const [label,pOver,aOver] of malformed){
  const answer=JSON.stringify({...(caseId==='s2'?{}:{fingerprint:{evidence:{execution:{payoff:{basis:'web_research'}},plotMechanics:'x'}}}),prediction:{predictedRating:3,probability4Plus:0.4,confidence:'low',mainRisk:'x',moodLabels:['a','b'],...pOver},assessment:{research:{status:'not_attempted'},...aOver}});
  let rows;assert.doesNotThrow(()=>{rows=grade({runs:[run]},{[run.runId]:{answer}});},caseId+' '+label+' must not throw');
  const checks=rows[0].checks;assert.ok(checks.some(c=>c.id==='grounding_review'&&c.status==='flag'),caseId+' '+label+' graded');
  if('matchSignals' in pOver&&!Array.isArray(pOver.matchSignals))assert.equal(checks.find(c=>c.id==='match_signals_shape').status,'fail',caseId+' '+label+' is a normal shape fail');
 }
}
{const run={runId:'m-all',caseId:'s4',variant:'base',replicate:1};
 const rows=grade({runs:[run,{...run,runId:'m-ok'}]},{'m-all':{answer:JSON.stringify({prediction:{matchSignals:{x:'y'}},assessment:{}})},'m-ok':{answer:JSON.stringify({prediction:{predictedRating:2,probability4Plus:0.04,matchSignals:[]},assessment:{}})}});
 assert.equal(rows.length,2,'one malformed answer does not abort grading of the others');}

console.log('prediction-scoring-candidate-v2: v1->v2 minimal diff, base+two lines, harness reproducibility and matchSignals grader checks passed (static)');
