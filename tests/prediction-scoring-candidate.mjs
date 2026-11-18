// AIR-476: the evidence-aware scoring candidate for the batch v2 caller, its blind offline fixtures and the grader.
// Static checks only: historical v1 candidate integrity against the frozen pre-install prompt, fixture blindness and leakage,
// and the grader on hand-written synthetic outputs. This is not a semantic A/B; no model, network, production or
// Scheduled Task operation is involved.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {evaluate,loadFixtures} from '../scripts/prediction-scoring-rubric.mjs';

const sha=text=>createHash('sha256').update(text).digest('hex');
const block=(doc,name)=>{const m=doc.match(new RegExp('---BEGIN '+name+'---\\n([\\s\\S]*?)\\n---END '+name+'---'));assert.ok(m,name+' markers present');return m[1];};
const canonicalDoc=fs.readFileSync('docs/reference/scheduled-task-prompts/hourly-predictions-batch-v2.md','utf8');
const historicalBaseDoc=fs.readFileSync('docs/evidence/prediction/air-476-preinstall-baseline-2026-11-17.md','utf8');
const evidenceDoc=fs.readFileSync('docs/evidence/prediction/air-476-evidence-aware-scoring-candidate-2026-11-17.md','utf8');
const base=block(historicalBaseDoc,'PROMPT'),dry=block(canonicalDoc,'DRY RUN PROMPT'),candidate=block(evidenceDoc,'CANDIDATE PROMPT');

// 1. Stated hashes. The historical base was installed before AIR-476; v1 was never installed.
const BASE_SHA='1192b92c3d50a2478afd27b06b2d055972375497374e237ef212b6b6e5e2c95c',CANDIDATE_SHA='1826af6f11eb3aad6d3f2dd4c40542b93d0040e46d316cd3d9bf30168c4ee2c1';
assert.equal(sha(base),BASE_SHA,'frozen pre-install baseline must never drift when canonical production changes');
assert.equal(base.length,42097);
assert.equal(sha(candidate),CANDIDATE_SHA);assert.equal(candidate.length,45165);assert.equal(Buffer.byteLength(candidate,'utf8'),68066);
for(const [len,bytes,hash] of [[42097,63331,BASE_SHA],[45165,68066,CANDIDATE_SHA]])assert.ok(new RegExp('\\| '+len+' \\| '+bytes+' \\| `'+hash+'` \\|').test(evidenceDoc),'evidence table states '+hash);
assert.ok(!base.includes('EVIDENCE-AWARE SCORING'),'historical base must not incorporate later scoring policy');
assert.ok(/Status: candidate, NOT installed/.test(evidenceDoc));

// 2. Exactly two inserted lines, at the stated places; everything else byte-identical.
const B=base.split('\n'),C=candidate.split('\n');
assert.equal(C.length,B.length+2);
const i6=B.findIndex(l=>l.startsWith('6. Вкус:')),ig=B.findIndex(l=>l.startsWith('**Причина gate:**'));
assert.ok(i6>0&&ig>i6);
const step6a=C[i6+1],reportLine=C[ig+2];
assert.ok(step6a.startsWith('6а. EVIDENCE-AWARE SCORING'));assert.ok(reportLine.startsWith('**Основания оценки:**'));
assert.deepEqual([...C.slice(0,i6+1),...C.slice(i6+2,ig+2),...C.slice(ig+3)],B,'only the two lines are inserted');
assert.equal(step6a.length,2886);assert.equal(reportLine.length,180);

// 3. Generation steps stay identical to the base and to the frozen dry-run prompt (the A/B equality test keeps passing after install).
const steps=text=>text.split('\n').filter(l=>/^(?:[456]|3а)\. /.test(l));
assert.equal(steps(candidate).length,4);assert.deepEqual(steps(candidate),steps(base));
assert.deepEqual(steps(candidate),steps(dry),'steps 3а, 4, 5, 6 identical to the frozen dry-run prompt');
assert.ok(!/^6а\. /m.test(dry),'the frozen dry-run prompt is not changed');

// 4. Invariants the card fixes: research budget, batch parameters and protocol.
for(const needle of ['manifestSize=5','generationSize=1','submitBatchSize=5','НЕ БОЛЕЕ 2 web search запросов на фильм и НЕ БОЛЕЕ 3 независимо написанных источников','prediction_batch_validate({items})','prediction_batch_hold({runId,epoch,items})','prediction_batch_submit({runId,epoch,items})','Не используй assessPredictionConfidence'])assert.ok(candidate.includes(needle),'invariant kept: '+needle);
assert.ok(!/\b(?:AIR-\d+|S5-C)\b/.test(step6a+reportLine),'no ticket ids in executable text');

// 5. The policy itself.
for(const needle of [
 'Отсутствие evidence — это НЕОПРЕДЕЛЁННОСТЬ, а не плохое исполнение',
 'подтверждённый плюс, подтверждённый минус, unknown',
 'unknown НИКОГДА не превращай в минус',
 'не ставь direction=against или risk severity=high на основании того, что не подтверждено',
 'нижнего порога predictedRating или P4+ нет',
 'это не числовой пол и не повод повышать',
 'Не повышай оценку автоматически',
 'не заполняй пробелы выдуманными',
 'при predictedRating <=2.5 или P4+ <=0.20 в ratingBasis назван хотя бы один подтверждённый минус',
 'при predictedRating >=4.5 или P4+ >=0.80 — хотя бы один подтверждённый плюс',
 'search_snippet, оценки критиков',
 'confidence=low',
 'prediction_only',
 'Это не новый поиск',
 'новых полей в fingerprint, prediction или assessment не добавляй',
])assert.ok(step6a.includes(needle),'policy: '+needle);
assert.ok(!/(?:не ниже|минимум|не менее)\s*[0-9]/.test(step6a),'no artificial rating or P4+ floor');
assert.ok(/Unknown не называй минусом/.test(reportLine)&&/подтверждённые минусы/.test(reportLine));
{const step11=candidate.slice(candidate.indexOf('11. После prediction_complete'));
 assert.ok(step11.indexOf('**Причина gate:**')<step11.indexOf('**Основания оценки:**')&&step11.indexOf('**Основания оценки:**')<step11.indexOf('**Full-text fallback:**'),'report line sits inside the per-film block');}

// 6. Fixture blindness and leakage.
const inputsRaw=fs.readFileSync('tests/fixtures/prediction-scoring-air-476/generator-inputs.json','utf8');
const {inputs,rubric}=loadFixtures();
assert.deepEqual(inputs.films.map(f=>f.caseId).sort(),Object.keys(rubric.cases).sort(),'every case has a rubric');
for(const forbidden of ['"label"','"expect"','confirmedMinus','confirmedPlus','keyUnknown','maxPredictedRating','Resident Evil','SEXE','sparse_legacy','confirmed_defects','predictedRating','probability4Plus','ownerRating','actualRating','"rating"'])assert.ok(!inputsRaw.includes(forbidden),'generator input does not leak: '+forbidden);
assert.ok(!/\b4\.0\b|55 ?%|\b3 ?%/.test(inputsRaw),'no historical outcome in the generator input');
for(const f of inputs.films){
 assert.ok(/^s\d$/.test(f.caseId),'opaque case id');
 for(const c of f.researchCorpus)assert.ok(new URL(c.url).hostname.endsWith('example.org'),'synthetic corpus URL');
 assert.ok(/^Synthetic Director/.test(f.modelMetadata.credits.directors[0]),'synthetic credits');
}
assert.ok(inputs.films.every((f,i)=>f.caseId==='s'+(i+1))&&rubric.cases.s1.label.startsWith('c_')&&rubric.cases.s2.label.startsWith('a_'),'case order is shuffled against the card order');
{const sparse=inputs.films.find(f=>f.plan==='prediction_only');const ex=Object.values(sparse.fingerprint.execution);
 assert.equal(ex.length,13);assert.equal(ex.filter(v=>v==='unknown').length,12,'case (a) mirrors 12 of 13 unknown');assert.equal(sparse.fingerprint.evidence,undefined,'case (a) is legacy-shaped without evidence');}
assert.ok(!/target|correct rating|expectedRating/i.test(JSON.stringify(rubric.cases)),'the rubric has no target rating');

// 7. The grader on synthetic outputs. Good outputs pass with no fail; each bad output fails or flags exactly where it should.
const snip='https://search.example.org/hollow-signal-snippet';
const assess=(over={})=>({assessmentVersion:1,ratingBasis:'basis',probability4PlusBasis:'basis',tasteSignals:[],risks:[],uncertainties:[],research:{status:'not_attempted'},sources:[{kind:'metadata',ref:'metadata:synopsis',usedFor:'premise'}],model:{status:'unavailable'},...over});
const pred=(over={})=>({predictedRating:3.5,probability4Plus:0.4,confidence:'low',matchSignals:['siege'],mainRisk:'качество payoff не подтверждено',moodLabels:['напряжённо','мрачно'],...over});
const good=[
 {caseId:'s1',fingerprint:{evidence:{execution:{plan_counterplan_strength:[{basis:'web_research',refs:['https://reviews.example.org/quiet-ledger-partial'],confidence:'medium'}]}}},prediction:pred({predictedRating:4,probability4Plus:0.6,confidence:'medium'}),assessment:assess({research:{status:'attempted_found'},sources:[{kind:'web_research',ref:'https://reviews.example.org/quiet-ledger-partial',usedFor:'plan',access:'partial_text'}],tasteSignals:[{direction:'supports',signal:'ясный план и компетентный следователь'}],uncertainties:['payoff и финал не подтверждены']})},
 {caseId:'s2',prediction:pred({predictedRating:3,probability4Plus:0.3}),assessment:assess({research:{status:'attempted_found'},sources:[{kind:'web_research',ref:snip,usedFor:'snippet only',access:'search_snippet'}],uncertainties:['исполнение осады не подтверждено']})},
 {caseId:'s3',prediction:pred({predictedRating:4.5,probability4Plus:0.75,confidence:'high'}),assessment:assess({research:{status:'attempted_found'},sources:[{kind:'web_research',ref:'https://reviews.example.org/glasshouse-inquest-1',usedFor:'clues',access:'full_text'}],tasteSignals:[{direction:'supports',signal:'честные улики и заработанный финал'}]})},
 {caseId:'s4',prediction:pred({predictedRating:2,probability4Plus:0.05,confidence:'high',mainRisk:'команда расходится без причины'}),assessment:assess({research:{status:'attempted_found'},sources:[{kind:'web_research',ref:'https://reviews.example.org/below-deck-nine-1',usedFor:'defects',access:'full_text'}],tasteSignals:[{direction:'against',signal:'игнорируют вентиляцию из первой сцены'}],risks:[{risk:'правила существа меняются',severity:'high'}]})},
];
const g=evaluate(good,{inputs,rubric});
assert.equal(g.summary.fail,0,JSON.stringify(g.cases.flatMap(c=>c.checks.filter(x=>x.status==='fail'))));
const status=(res,caseId,id)=>res.cases.find(c=>c.caseId===caseId).checks.find(x=>x.id===id)?.status;
assert.equal(status(g,'s2','no_unknown_to_negative'),'pass');assert.equal(status(g,'s4','justified_negative_kept'),'pass');
assert.equal(status(g,'s4','low_extreme_has_negative'),'flag','an extreme is never auto-passed: grounding is a human check');
assert.equal(status(g,'s3','high_extreme_has_positive'),'flag');
assert.equal(status(g,'s1','readable_corpus_used'),'pass');assert.equal(status(g,'s1','unknown_claimed_as_fact'),'pass');
// No case is ever clean: semantic grounding is a mandatory human review item on every output.
for(const c of g.cases)assert.equal(c.checks.find(x=>x.id==='grounding_review')?.status,'flag',c.caseId+' carries a grounding review flag');
assert.ok(g.summary.flag>=g.cases.length);

const swap=(caseId,o)=>good.map(x=>x.caseId===caseId?{...x,...o}:x);
// unknown -> negative shortcut on the sparse case
let r=evaluate(swap('s2',{prediction:pred({predictedRating:2,probability4Plus:0.03}),assessment:assess({research:{status:'attempted_found'},sources:[{kind:'web_research',ref:snip,usedFor:'s',access:'search_snippet'}],tasteSignals:[{direction:'against',signal:'слабый payoff и тупые решения героев'}],uncertainties:['x']})}),{inputs,rubric});
assert.equal(status(r,'s2','no_unknown_to_negative'),'flag');
r=evaluate(swap('s2',{prediction:pred({predictedRating:2,probability4Plus:0.03}),assessment:assess({research:{status:'attempted_found'},sources:[{kind:'web_research',ref:snip,usedFor:'s',access:'search_snippet'}],uncertainties:['x']})}),{inputs,rubric});
assert.equal(status(r,'s2','low_extreme_has_negative'),'fail','a negative extreme without any against signal fails');
// overconfidence and a read claim from a snippet on the sparse case
r=evaluate(swap('s2',{prediction:pred({confidence:'medium'}),assessment:assess({research:{status:'attempted_found'},sources:[{kind:'web_research',ref:snip,usedFor:'s',access:'full_text'}],uncertainties:[]})}),{inputs,rubric});
for(const id of ['confidence_honest','provenance','no_read_claim_without_text','uncertainty_recorded'])assert.equal(status(r,'s2',id),'fail',id);
// prediction_only must not send a fingerprint
r=evaluate(swap('s2',{fingerprint:{}}),{inputs,rubric});assert.equal(status(r,'s2','prediction_only_no_fingerprint'),'fail');
// hallucinated URL and inconsistent research status
r=evaluate(swap('s3',{assessment:assess({research:{status:'attempted_found'},sources:[{kind:'web_research',ref:'https://reviews.example.org/invented',usedFor:'x',access:'full_text'}]})}),{inputs,rubric});
assert.equal(status(r,'s3','provenance'),'fail');
r=evaluate(swap('s3',{assessment:assess({research:{status:'attempted_found'}})}),{inputs,rubric});
assert.equal(status(r,'s3','research_status_consistent'),'fail');
// blanket optimism erases the confirmed defects
r=evaluate(swap('s4',{prediction:pred({predictedRating:4,probability4Plus:0.6}),assessment:assess()}),{inputs,rubric});
assert.equal(status(r,'s4','justified_negative_kept'),'fail');assert.equal(status(r,'s4','negative_signal_present'),'fail');
// unfounded high risk on the substantive positive case
r=evaluate(swap('s3',{assessment:assess({risks:[{risk:'неправдоподобный финал',severity:'high'}]})}),{inputs,rubric});
assert.equal(status(r,'s3','no_unfounded_high_risk'),'flag');assert.equal(status(r,'s3','no_unknown_to_negative'),'flag');
// Review P1: s4 with no research and an invented negative at a non-extreme score is not clean.
r=evaluate(swap('s4',{prediction:pred({predictedRating:3,probability4Plus:0.3}),assessment:assess({tasteSignals:[{direction:'against',signal:'выдуманный дефект'}]})}),{inputs,rubric});
assert.equal(status(r,'s4','readable_corpus_used'),'fail','readable reviews in the corpus were not used');
assert.equal(status(r,'s4','grounding_review'),'flag');
assert.ok(r.cases.find(c=>c.caseId==='s4').checks.some(x=>x.status!=='pass'));
// Review P1: s1 with an invented positive about the unknown payoff at a non-extreme score is not clean.
r=evaluate(swap('s1',{prediction:pred({predictedRating:4,probability4Plus:0.6,confidence:'medium'}),assessment:assess({research:{status:'attempted_found'},sources:[{kind:'web_research',ref:'https://reviews.example.org/quiet-ledger-partial',usedFor:'plan',access:'partial_text'}],tasteSignals:[{direction:'supports',signal:'блестящий заработанный payoff в финале'}],uncertainties:['химия не подтверждена']})}),{inputs,rubric});
assert.equal(status(r,'s1','unknown_claimed_as_fact'),'flag','a positive claim on an unknown aspect is flagged');
assert.equal(status(r,'s1','grounding_review'),'flag');
// a missing output fails
r=evaluate(good.slice(1),{inputs,rubric});assert.equal(status(r,'s1','output_present'),'fail');
// rating shape
r=evaluate(swap('s1',{prediction:pred({predictedRating:3.7})}),{inputs,rubric});assert.equal(status(r,'s1','rating_shape'),'fail');

console.log('prediction-scoring-candidate: candidate integrity, fixture blindness and grader checks passed (static, not a semantic A/B)');
