// AIR-476: the offline A/B harness builds symmetric, blind generator prompts and grades raw answers deterministically.
// No model, network, MCP, production or Scheduled Task operation is involved.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {plan,promptTexts,grade,aggregate,PREAMBLE,CONTRACT,REPLICATES} from '../scripts/prediction-scoring-ab-harness.mjs';
import {loadFixtures} from '../scripts/prediction-scoring-rubric.mjs';

const {inputs,rubric}=loadFixtures();
const texts=promptTexts();
// 1. Variant texts: verbatim installed scoring steps; the candidate differs only by its step 6а.
assert.deepEqual(texts.candidate.slice(0,5),texts.base,'shared steps identical in both variants');
assert.equal(texts.candidate.length,6);assert.ok(texts.candidate[5].startsWith('6а. EVIDENCE-AWARE SCORING'));
for(const t of texts.base)assert.ok(!t.includes('EVIDENCE-AWARE'));

// 2. The plan: 4 cases x 2 variants x 3 replicates, deterministic shuffled order, stable method fingerprint.
const a=plan(),b=plan();
assert.equal(a.runs.length,inputs.films.length*2*REPLICATES);assert.equal(a.runs.length,24);
assert.deepEqual(a.runs.map(r=>r.runId),b.runs.map(r=>r.runId),'order is reproducible from the seed');
assert.equal(a.methodFingerprint,b.methodFingerprint);
assert.notDeepEqual(a.runs.map(r=>r.caseId+r.variant),[...a.runs].sort((x,y)=>(x.caseId+x.variant).localeCompare(y.caseId+y.variant)).map(r=>r.caseId+r.variant),'order is shuffled, not grouped');
for(const c of inputs.films)for(const v of ['base','candidate'])assert.equal(a.runs.filter(r=>r.caseId===c.caseId&&r.variant===v).length,REPLICATES);

// 3. Symmetry: removing the candidate's step 6а from its prompt yields the base prompt of the same case, byte for byte.
for(const c of inputs.films){
 const base=a.runs.find(r=>r.caseId===c.caseId&&r.variant==='base').prompt,cand=a.runs.find(r=>r.caseId===c.caseId&&r.variant==='candidate').prompt;
 assert.equal(cand.replace('\n'+texts.candidate[5],''),base,c.caseId+': variants differ only by step 6а');
 for(const r of a.runs.filter(r=>r.caseId===c.caseId&&r.variant==='base'))assert.equal(r.prompt,base,'replicates get identical prompts');
}

// 4. Blindness: no rubric content, labels, expectations or historical outcome in any generator prompt; only the case's own corpus.
const rubricStrings=[...Object.values(rubric.cases).map(c=>c.label),'confirmedMinus','confirmedPlus','keyUnknown','maxPredictedRating','grader-rubric','keyUnknownPattern','grounding_review','Resident Evil','SEXE'];
for(const r of a.runs){
 for(const s of rubricStrings)assert.ok(!r.prompt.includes(s),r.runId+' leaks '+s);
 const film=inputs.films.find(f=>f.caseId===r.caseId);
 for(const other of inputs.films.filter(f=>f.caseId!==r.caseId))for(const c of other.researchCorpus)assert.ok(!r.prompt.includes(c.url),r.runId+' sees another case corpus');
 assert.ok(r.prompt.includes(JSON.stringify(film.researchCorpus)));
 assert.ok(!/caseId|s[1-4]\b/.test(r.prompt.replace(/\bs[1-4]\b(?=")/g,'')),'no case id in the prompt');
}
assert.ok(PREAMBLE.includes('НЕТ IPTV MCP, web search')&&CONTRACT.includes('ровно один JSON-объект'));

// 5. Grading: a parsed answer is graded by the rubric; an unparseable, failure or missing answer fails; aggregates count statuses.
const one=a.runs.find(r=>r.caseId==='s4'&&r.variant==='candidate');
const good={prediction:{predictedRating:2,probability4Plus:0.05,confidence:'medium',matchSignals:[],mainRisk:'x',moodLabels:['a','b']},assessment:{research:{status:'attempted_found'},sources:[{kind:'web_research',ref:'https://reviews.example.org/below-deck-nine-1',access:'full_text',usedFor:'x'}],tasteSignals:[{direction:'against',signal:'план игнорирует вентиляцию'}],risks:[],uncertainties:['x']}};
const rows=grade({runs:[one,{...one,runId:'x2'},{...one,runId:'x3'},{...one,runId:'x4'}]},{[one.runId]:{answer:'```json\n'+JSON.stringify(good)+'\n```',toolUses:1},x2:{answer:'not json'},x3:{answer:JSON.stringify({failure:{kind:'parse_error',reason:'insufficient_evidence'}})}});
assert.equal(rows[0].checks.filter(c=>c.status==='fail').length,0);assert.equal(rows[0].toolUses,1);assert.equal(rows[0].predictedRating,2);
assert.ok(rows[0].checks.some(c=>c.id==='grounding_review'&&c.status==='flag'));
for(const r of rows.slice(1))assert.equal(r.checks[0].status,'fail',r.runId+' fails');
const agg=aggregate(rows);assert.equal(agg.length,1);assert.equal(agg[0].n,4);assert.ok(agg[0].fail>=3&&agg[0].flag>=1);

console.log('prediction-scoring-ab-harness: symmetric blind prompts, reproducible order and grading passed (no model call)');
