// AIR-19 UI: the film forecast renders an optional confidenceAssessment and leaves the
// model confidence, Finds and Similar on the stored field when the assessment is absent.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const app=fs.readFileSync('public/app.js','utf8');
const css=fs.readFileSync('public/styles.css','utf8');
assert.doesNotMatch(app,/assessPredictionConfidence/);
assert.match(css,/\.evidence-confidence-level strong\{[^}]*font-size:12px/);
assert.match(css,/\.evidence-confidence\[data-level=high\]/);
assert.match(css,/\.evidence-confidence\[data-level=low\]/);
assert.doesNotMatch(css,/\.evidence-confidence\{[^}]*display:\s*none/);
const source=app.replace(/init\(\);\s*$/,'');
const live=vm.createContext({
 Date,Intl,Set,Map,URL,URLSearchParams,JSON,window:{location:{href:'https://iptv.example/film/heat-1995'},history:{pushState(){},replaceState(){},back(){},forward(){}}},
 document:{documentElement:{classList:{toggle(){},add(){},remove(){}}},querySelector(){return null;},querySelectorAll(){return [];},addEventListener(){}},
 fetch(){throw new Error('the confidence fixture must not fetch');}
});
vm.runInContext(source,live);
const run=code=>vm.runInContext(code,live);
const film={id:'heat-1995',title:'Жара'};
const base={predictedRating:4.2,probability4Plus:0.8,confidence:'high',matchSignals:['Сильный сюжет'],mainRisk:'Темп <может> просесть',stale:false};
run(`films=[];enrichment={films:{'heat-1995':{actualRating:4.5,prediction:${JSON.stringify(base)}}}}`);
const stored=run('JSON.stringify(enrichment)');
const plain=run(`filmScore(${JSON.stringify(film)})`);
assert.match(plain,/уверенность высокая/);
assert.doesNotMatch(plain,/уверенность модели|Качество доказательств|evidence-confidence/);
assert.match(plain,/Темп &lt;может&gt; просесть/);
assert.equal(run('JSON.stringify(enrichment)'),stored);
assert.equal(run('findsStrong(enrichment.films["heat-1995"].prediction)'),true);
assert.equal(run('similarNumbers(enrichment.films["heat-1995"].prediction).confidence'),'high');

const assessment={assessmentVersion:1,level:'low',status:'legacy',reasonCodes:['legacy_no_evidence','<script>'],coverage:{mechanicsAsserted:0,mechanicsSupported:0,keyApplicable:0,keyConcrete:0,keySupported:0,keyUnknown:0,keyNotApplicable:0,genrePresent:0,genreSupported:0},fingerprintHash:null};
run(`enrichment.films['heat-1995'].prediction.confidenceAssessment=${JSON.stringify(assessment)}`);
const legacy=run(`filmScore(${JSON.stringify(film)})`);
assert.match(legacy,/уверенность модели высокая/);
assert.match(legacy,/Качество доказательств: <strong>низкое<\/strong>/);
assert.match(legacy,/data-level="low"/);
assert.match(legacy,/data-status="legacy"/);
assert.match(legacy,/У отпечатка нет карты доказательств\./);
assert.doesNotMatch(legacy,/<script>|alert/);
assert.match(legacy,/title="У отпечатка нет карты доказательств\."/);
assert.equal(run('findsStrong(enrichment.films["heat-1995"].prediction)'),false,'a legacy assessment is low and does not keep the model high');
assert.equal(run('similarNumbers(enrichment.films["heat-1995"].prediction).confidence'),'high');

run(`enrichment.films['heat-1995'].prediction.confidence='low'`);
run(`enrichment.films['heat-1995'].prediction.confidenceAssessment.level='high'`);
run(`enrichment.films['heat-1995'].prediction.confidenceAssessment.status='evidenced'`);
run(`enrichment.films['heat-1995'].prediction.confidenceAssessment.reasonCodes=['declared_source_not_verified']`);
const evidenced=run(`filmScore(${JSON.stringify(film)})`);
assert.match(evidenced,/Качество доказательств: <strong>высокое<\/strong>/);
assert.match(evidenced,/Источник заявлен моделью или ссылкой и отдельно не проверялся\./);
assert.match(evidenced,/уверенность модели низкая/);
assert.equal(run('findsStrong(enrichment.films["heat-1995"].prediction)'),false,'a high assessment without the snapshot hash does not promote a low model confidence');
assert.equal(run(`evidenceConfidenceHtml({assessmentVersion:1,level:'<img>',status:'evidenced',reasonCodes:[]})`),'');
assert.equal(run(`evidenceConfidenceHtml({assessmentVersion:1,level:'high',status:'legacy',reasonCodes:[]})`),'');
assert.equal(run(`evidenceConfidenceHtml({assessmentVersion:1,level:'high',status:'evidenced'})`),'','version, level and status alone do not render');
const inherited={assessmentVersion:1,reasonCodes:['legacy_no_evidence'],coverage:{mechanicsAsserted:0,mechanicsSupported:0,keyApplicable:0,keyConcrete:0,keySupported:0,keyUnknown:0,keyNotApplicable:0,genrePresent:0,genreSupported:0},fingerprintHash:null};
assert.equal(run(`evidenceConfidenceHtml(${JSON.stringify({...inherited,level:'toString',status:'evidenced'})})`),'','an inherited level name does not render');
assert.equal(run(`evidenceConfidenceHtml(${JSON.stringify({...inherited,level:'low',status:'constructor'})})`),'','an inherited status name does not render');
const dropped=JSON.parse(JSON.stringify(assessment));
delete dropped.coverage.keySupported;
dropped.level='high';
dropped.status='evidenced';
dropped.reasonCodes=['declared_source_not_verified'];
assert.equal(run(`evidenceConfidenceHtml(${JSON.stringify(dropped)})`),'','a missing coverage count does not render');
dropped.coverage.keySupported=100;
assert.equal(run(`evidenceConfidenceHtml(${JSON.stringify(dropped)})`),'','a coverage count outside 0–99 does not render');
const hash='ab'.repeat(32),other='cd'.repeat(32);
const bound={...assessment,level:'high',status:'evidenced',reasonCodes:['declared_source_not_verified'],fingerprintHash:hash};
assert.equal(run(`evidenceConfidenceHtml(${JSON.stringify(bound)},${JSON.stringify(other)})`),'');
assert.equal(run(`evidenceConfidenceHtml(${JSON.stringify({...bound,fingerprintHash:null})},${JSON.stringify(hash)})`),'','an unbound assessment does not attach to a hashed prediction');
assert.match(run(`evidenceConfidenceHtml(${JSON.stringify(bound)},${JSON.stringify(hash)})`),/Качество доказательств: <strong>высокое<\/strong>/);
run(`enrichment.films['heat-1995'].prediction.fingerprintHash=${JSON.stringify(other)}`);
run(`enrichment.films['heat-1995'].prediction.confidenceAssessment.fingerprintHash=${JSON.stringify(hash)}`);
const mismatch=run(`filmScore(${JSON.stringify(film)})`);
assert.doesNotMatch(mismatch,/Качество доказательств|evidence-confidence/);
assert.match(mismatch,/уверенность низкая/);
assert.doesNotMatch(mismatch,/уверенность модели/);
run(`enrichment.films['heat-1995'].prediction.fingerprintHash=${JSON.stringify(hash)}`);
const matched=run(`filmScore(${JSON.stringify(film)})`);
assert.match(matched,/Качество доказательств: <strong>высокое<\/strong>/);
assert.match(matched,/уверенность модели низкая/);
assert.equal(run('findsStrong(enrichment.films["heat-1995"].prediction)'),true,'a bound high assessment is the Finds level');
const malformed={assessmentVersion:1,level:'high',status:'evidenced',fingerprintHash:hash};
run(`enrichment.films['heat-1995'].prediction.confidence='high'`);
run(`enrichment.films['heat-1995'].prediction.fingerprintHash=${JSON.stringify(hash)}`);
run(`enrichment.films['heat-1995'].prediction.confidenceAssessment=${JSON.stringify(malformed)}`);
assert.equal(run(`evidenceConfidenceHtml(${JSON.stringify(malformed)},${JSON.stringify(hash)})`),'','a hash-bound assessment without reason codes or coverage does not render');
assert.equal(run('effectiveConfidence(enrichment.films["heat-1995"].prediction)'),'low','a hash-bound assessment without reason codes or coverage is low');
assert.equal(run('findsStrong(enrichment.films["heat-1995"].prediction)'),false,'Finds does not keep a malformed bound assessment as high');
const copied=run('similarNumbers(enrichment.films["heat-1995"].prediction)');
assert.equal(Object.hasOwn(copied,'confidenceAssessment'),true);
assert.equal(run(`findsStrong({predictedRating:4.2,probability4Plus:0.8,confidence:'high',stale:false,fingerprintHash:${JSON.stringify(hash)},confidenceAssessment:similarNumbers(enrichment.films["heat-1995"].prediction).confidenceAssessment})`),false,'Similar uses the same malformed assessment as low');
run(`enrichment.films['heat-1995'].prediction.confidenceAssessment=null`);
assert.equal(run('effectiveConfidence(enrichment.films["heat-1995"].prediction)'),'low','a present null assessment is low');
assert.equal(run('findsStrong(enrichment.films["heat-1995"].prediction)'),false);
