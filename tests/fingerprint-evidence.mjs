// AIR-46: optional fingerprint evidence on schema 1. The map is checked only when present,
// hashed with the content, and left out of the D1 feature index. A fingerprint without it
// keeps the caller-owned source fields and the previous freshness verdict.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {fingerprintContentHash, fingerprintPointerAgrees} from '../src/prediction-d1.js';

const records=new Map(),etags=new Map();let revision=0;
const env={BUCKET:{async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key)),text:async()=>JSON.stringify(records.get(key))}:null},async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};},list:async()=>({objects:[],truncated:false})}};
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
for(const file of ['src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-versions.js','src/enrichment.js','src/letterboxd-diary.js','src/prediction-diagnostics.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
const call=code=>vm.runInContext(code,ctx),plain=value=>JSON.parse(JSON.stringify(value));
const issuesOf=(fingerprint,metadata)=>plain(call('fingerprintIssues')(fingerprint,metadata));
const codes=(fingerprint,metadata)=>issuesOf(fingerprint,metadata).map(issue=>issue.path+' '+issue.code);
async function api(path,body,method='POST'){const response=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:response.status,data:await response.json()};}
const EXECUTION=plain(call('EXECUTION'));
const unknownExecution=Object.fromEntries(Object.entries(EXECUTION).map(([key,values])=>[key,values.includes('unknown')?'unknown':values[0]]));
const metadata={synopsis:'A crew plans a robbery.',genres:['Crime'],runtime:170,directors:['Michael Mann'],actors:['Al Pacino']};
const item=(basis,refs,confidence='medium')=>({basis,refs,confidence});
const legacy={fingerprintSchemaVersion:1,plotMechanics:['heist'],execution:{...unknownExecution},moodLabels:['мрачный','напряжённый'],strengths:['A causal puzzle'],risks:['Mixed payoff'],confidence:'medium',sourceBasis:'model_knowledge',sourceRefs:['model_knowledge']};
const withEvidence=(extra={})=>{const fingerprint={...legacy,...extra,execution:{...unknownExecution,...(extra.execution||{})}};if(extra.evidence)fingerprint.evidence=extra.evidence;return fingerprint;};
const heistOnly=withEvidence({evidence:{plotMechanics:{heist:[item('metadata',['metadata:synopsis'])]}},sourceBasis:'metadata',sourceRefs:['metadata:synopsis']});

assert.equal(call('FINGERPRINT_SCHEMA_VERSION'),1);
assert.equal(call('FINGERPRINT_PROMPT_VERSION'),1);
assert.equal(call('PREDICTION_PROMPT_VERSION'),1);
assert.equal(call('FINGERPRINT_TRANSITIONS').length,0);
assert.equal(call('fingerprintCurrent')(legacy),true);
assert.equal(call('fingerprintCurrent')(heistOnly),true);
assert.deepEqual(issuesOf(legacy),[]);
assert.deepEqual(issuesOf({...legacy,sourceBasis:'mixed',sourceRefs:['model_knowledge','https://example.com/a']}),[],'a legacy mixed declaration needs no breakdown');
assert.deepEqual(issuesOf(heistOnly,metadata),[]);
assert.deepEqual(codes(heistOnly),['fingerprint.evidence.plotMechanics.heist invalid_ref'],'a metadata token with no metadata object is not a fact');

const supported=withEvidence({
 execution:{payoff:'strong',decision_logic:'strong'},
 evidence:{plotMechanics:{heist:[item('metadata',['metadata:synopsis','metadata:genres'])]},execution:{decision_logic:[item('web_research',['https://example.com/citation'])],payoff:[item('model_knowledge',['model_knowledge'])]}},
 sourceBasis:'mixed',sourceRefs:['metadata:synopsis','metadata:genres','https://example.com/citation','model_knowledge'],
});
assert.deepEqual(issuesOf(supported,metadata),[]);
assert.deepEqual(codes({...supported,sourceBasis:'metadata'},metadata),['fingerprint.sourceBasis invalid_enum']);
assert.deepEqual(codes({...supported,sourceRefs:['model_knowledge','metadata:synopsis','metadata:genres','https://example.com/citation']},metadata),['fingerprint.sourceRefs invalid_ref']);

const payoffOnly=withEvidence({execution:{payoff:'strong'},evidence:{execution:{payoff:[item('metadata',['metadata:synopsis'],'high')]}},sourceBasis:'metadata',sourceRefs:['metadata:synopsis']});
assert.deepEqual(codes(payoffOnly,metadata),['fingerprint.evidence.plotMechanics required','fingerprint.evidence.execution.payoff invalid_ref']);
const competence=withEvidence({plotMechanics:[],evidence:{execution:{protagonist_competence:[item('metadata',['metadata:synopsis'],'low')]}},execution:{protagonist_competence:'high'},sourceBasis:'metadata',sourceRefs:['metadata:synopsis']});
assert.deepEqual(codes(competence,metadata),['fingerprint.evidence.execution.protagonist_competence invalid_ref']);
assert.ok(codes(withEvidence({plotMechanics:[],evidence:{execution:{problem_solving:[item('metadata',['metadata:genres'])]}},execution:{problem_solving:'strong'},sourceBasis:'metadata',sourceRefs:['metadata:genres']}),metadata).includes('fingerprint.evidence.execution.problem_solving invalid_ref'));
assert.ok(codes(withEvidence({plotMechanics:[],evidence:{execution:{technical_plausibility:[item('metadata',['metadata:runtime'])]}},execution:{technical_plausibility:'strong'},sourceBasis:'metadata',sourceRefs:['metadata:runtime']}),metadata).includes('fingerprint.evidence.execution.technical_plausibility invalid_ref'));

const urls=Array.from({length:16},(_,index)=>'https://example.com/c/'+index);
const many=withEvidence({plotMechanics:[],evidence:{execution:{pace:urls.slice(0,16).reduce((items,url,index)=>{const bucket=items[Math.floor(index/4)]||(items[Math.floor(index/4)]=item('web_research',[]));bucket.refs.push(url);return items;},[])}},execution:{pace:'fast'},sourceBasis:'web_research',sourceRefs:urls.slice(0,8)});
assert.deepEqual(issuesOf(many,metadata),[],'sourceRefs keeps the first eight unique refs');
assert.ok(codes({...many,sourceRefs:urls},metadata).includes('fingerprint.sourceRefs too_many'));

assert.deepEqual(codes(withEvidence({evidence:{plotMechanics:{heist:[item('metadata',['metadata:poster'])]}},sourceBasis:'metadata',sourceRefs:['metadata:poster']}),metadata),['fingerprint.evidence.plotMechanics.heist invalid_ref']);
assert.deepEqual(codes(withEvidence({evidence:{plotMechanics:{heist:[item('web_research',['http://example.com/a'])]}},sourceBasis:'web_research',sourceRefs:['http://example.com/a']}),metadata),['fingerprint.evidence.plotMechanics.heist invalid_ref']);
for(const ref of ['https://127.0.0.1/a','https://10.1.2.3/a','https://192.168.1.1/a','https://172.16.0.1/a','https://169.254.1.1/a','https://localhost/a','https://film.internal/a','https://film.local/a','https://user:pass@example.com/a','https://[::1]/a'])
 assert.deepEqual(codes(withEvidence({evidence:{plotMechanics:{heist:[item('web_research',[ref])]}},sourceBasis:'web_research',sourceRefs:[ref]}),metadata),['fingerprint.evidence.plotMechanics.heist invalid_ref'],ref);
assert.deepEqual(codes(withEvidence({evidence:{plotMechanics:{heist:[item('model_knowledge',['https://example.com/a'])]}},sourceBasis:'model_knowledge',sourceRefs:['https://example.com/a']}),metadata),['fingerprint.evidence.plotMechanics.heist invalid_ref']);
assert.deepEqual(codes(withEvidence({evidence:{plotMechanics:{heist:[item('metadata',['metadata:synopsis'],'sure')]}},sourceBasis:'metadata',sourceRefs:['metadata:synopsis']}),metadata),['fingerprint.evidence.plotMechanics.heist invalid_enum']);
assert.deepEqual(codes(withEvidence({evidence:{plotMechanics:{heist:[item('metadata',['metadata:synopsis']),item('metadata',['metadata:synopsis'])]}},sourceBasis:'metadata',sourceRefs:['metadata:synopsis']}),metadata),['fingerprint.evidence.plotMechanics.heist invalid_ref']);
assert.ok(codes(withEvidence({evidence:{plotMechanics:{heist:[{...item('metadata',['metadata:synopsis']),quote:'long thought'}]},note:'x'},sourceBasis:'metadata',sourceRefs:['metadata:synopsis']}),metadata).includes('fingerprint.evidence invalid_type'));
assert.deepEqual(codes(withEvidence({evidence:{plotMechanics:{heist:[item('metadata',['metadata:synopsis'])]},execution:{made_up:[item('model_knowledge',['model_knowledge'])]}},sourceBasis:'mixed',sourceRefs:['metadata:synopsis','model_knowledge']}),metadata),['fingerprint.evidence.execution.made_up invalid_enum']);
assert.deepEqual(codes(withEvidence({plotMechanics:[],evidence:{},sourceBasis:'model_knowledge',sourceRefs:['model_knowledge']}),metadata),['fingerprint.evidence too_few']);
assert.deepEqual(codes(withEvidence({evidence:{plotMechanics:{}},sourceBasis:'metadata',sourceRefs:[]}),metadata),['fingerprint.evidence.plotMechanics.heist required']);
assert.deepEqual(codes(withEvidence({plotMechanics:[],execution:{pace:'fast'},evidence:{execution:{}},sourceBasis:'model_knowledge',sourceRefs:['model_knowledge']}),metadata),['fingerprint.evidence.execution.pace required']);
assert.deepEqual(codes(withEvidence({plotMechanics:[],execution:{technical_plausibility:'not_applicable'},evidence:{execution:{technical_plausibility:[item('model_knowledge',['model_knowledge'])]}},sourceBasis:'model_knowledge',sourceRefs:['model_knowledge']}),metadata),['fingerprint.evidence.execution.technical_plausibility invalid_enum']);
const genreFree=withEvidence({execution:{action_readability:'strong'},evidence:{plotMechanics:{heist:[item('metadata',['metadata:synopsis'])]}},sourceBasis:'metadata',sourceRefs:['metadata:synopsis']});
assert.deepEqual(issuesOf(genreFree,metadata),[],'a genre dimension stays optional when the map is present');
assert.deepEqual(codes(withEvidence({evidence:{plotMechanics:{chase: [item('metadata',['metadata:synopsis'])]}},sourceBasis:'metadata',sourceRefs:['metadata:synopsis']}),metadata),['fingerprint.evidence.plotMechanics.chase invalid_enum','fingerprint.evidence.plotMechanics.heist required']);
assert.deepEqual(codes(withEvidence({evidence:{plotMechanics:{heist:[item('metadata',['metadata:genres'])]}},sourceBasis:'metadata',sourceRefs:['metadata:genres']}),{...metadata,genres:[]}),['fingerprint.evidence.plotMechanics.heist invalid_ref']);
assert.deepEqual(issuesOf(withEvidence({evidence:{plotMechanics:{heist:[item('metadata',['metadata:credits','metadata:runtime'])]}},sourceBasis:'metadata',sourceRefs:['metadata:credits','metadata:runtime']}),metadata),[]);

const fat=repeats=>{
 const claim=()=>[0,1,2,3].map(n=>item('web_research',[0,1,2,3].map(m=>'https://example.com/'+'a'.repeat(repeats)+n+m)));
 const execution={pace:'fast',stakes:'high',plot_engine:'strong',chemistry:'strong'};
 const evidence={plotMechanics:{heist:claim()},execution:{pace:claim(),stakes:claim(),plot_engine:claim(),chemistry:claim()}};
 const refs=[];
 for(const group of [evidence.plotMechanics.heist,...Object.values(evidence.execution)])for(const entry of group)for(const value of entry.refs)if(!refs.includes(value)&&refs.length<8)refs.push(value);
 return withEvidence({execution,evidence,sourceBasis:'web_research',sourceRefs:refs});
};
const over=fat(200);
assert.ok(JSON.stringify(over).length>12000);
assert.deepEqual(codes(over,metadata),['fingerprint too_large']);
const under=fat(20);
assert.ok(JSON.stringify(under).length<12000);
assert.deepEqual(issuesOf(under,metadata),[]);

const legacyHash=await call('contentHash')({...legacy,filmId:'film-1'});
const evidencedHash=await call('contentHash')({...heistOnly,filmId:'film-1'});
assert.notEqual(legacyHash,evidencedHash);
assert.equal(legacyHash,await fingerprintContentHash({...legacy,filmId:'film-1'}));
assert.equal(evidencedHash,await fingerprintContentHash({...heistOnly,filmId:'film-1'}));
const pointer=(content,hash)=>({...content,filmId:'film-1',fingerprintHash:hash,generatedAt:'2026-11-02T12:00:00.000Z',invalidatedAt:null,fingerprintPromptVersion:1,produced:'generated',previous:null});
assert.ok(await fingerprintPointerAgrees(pointer(legacy,legacyHash)));
assert.equal(await fingerprintPointerAgrees(pointer(heistOnly,legacyHash)),null,'evidence changes the content hash');
assert.ok(await fingerprintPointerAgrees(pointer(heistOnly,evidencedHash)));
const facet=plain(call('fingerprintImpactFacet')({...heistOnly,fingerprintHash:evidencedHash}));
assert.equal(Object.hasOwn(facet,'evidence'),false);
const d1=fs.readFileSync('src/prediction-d1.js','utf8');
const features=d1.slice(d1.indexOf('function featuresOf'),d1.indexOf('function displayOf'));
assert.doesNotMatch(features,/evidence/);
assert.match(d1.slice(d1.indexOf('async function loadFingerprint'),d1.indexOf('async function loadPredictionRecord')),/\.\.\.body/);
assert.equal(call('predictionRunnerContract')().instructions.some(line=>/fingerprint\.evidence/.test(line)),false);
const schema=(await api('schema',undefined,'GET')).data;
assert.equal(schema.rules.some(line=>/fingerprint\.evidence/.test(line)),false);
const published=schema.contract.fingerprint.evidence;
assert.equal(published.required,false);
assert.equal(published.whenAbsent,'legacy');
assert.deepEqual(published.basis,['metadata','model_knowledge','web_research']);
assert.deepEqual(published.metadataRefs,['metadata:synopsis','metadata:genres','metadata:runtime','metadata:credits']);
assert.deepEqual(published.metadataSupports,['plotMechanics']);
assert.equal(published.maxItems,4);assert.equal(published.maxRefs,4);assert.equal(published.sourceRefCap,8);
assert.deepEqual(published.aggregate.order,['plotMechanics','generalExecution','genreExecution']);
assert.match(published.aggregate.basis,/mixed/);
assert.match(published.metadataPreflight,/prediction_validate/);
assert.match(published.claimCoverage.generalExecution,/unknown/);
for(const key of ['plot_engine','pace','stakes','chemistry','plan_counterplan_strength','multi_party_goals','decision_logic','payoff','action_readability'])assert.ok(published.executionQuality.includes(key),key);
assert.equal(Object.hasOwn(schema.contract.fingerprint.rules,'evidence'),false);
assert.match(schema.fingerprint.evidence,/optional/);
const metadataOnly=(dimension,value)=>withEvidence({execution:{[dimension]:value},evidence:{plotMechanics:{heist:[item('metadata',['metadata:synopsis'])]},execution:{[dimension]:[item('metadata',['metadata:synopsis'],'high')]}},sourceBasis:'metadata',sourceRefs:['metadata:synopsis']});
for(const [dimension,value] of [['chemistry','strong'],['plan_counterplan_strength','strong'],['multi_party_goals','strong'],['plot_engine','strong'],['pace','fast'],['stakes','high'],['action_readability','strong']])
 assert.deepEqual(codes(metadataOnly(dimension,value),metadata),['fingerprint.evidence.execution.'+dimension+' invalid_ref'],dimension);
const chemistryMixed=withEvidence({execution:{chemistry:'strong'},evidence:{plotMechanics:{heist:[item('metadata',['metadata:synopsis'])]},execution:{chemistry:[item('metadata',['metadata:synopsis']),item('model_knowledge',['model_knowledge'])]}},sourceBasis:'mixed',sourceRefs:['metadata:synopsis','model_knowledge']});
assert.deepEqual(issuesOf(chemistryMixed,metadata),[]);

const recorded=plain(call('predictionDiagnosticEvidence')(heistOnly));
assert.equal(recorded.status,'recorded');
assert.equal(recorded.note,'declared_source_not_verified');
assert.deepEqual(recorded.claims,[{group:'mechanic',dimension:'heist',value:'heist',items:[{basis:'metadata',refs:['metadata:synopsis'],confidence:'medium'}]}]);
assert.equal(plain(call('predictionDiagnosticEvidence')(legacy)).status,'legacy');
assert.deepEqual(plain(call('predictionDiagnosticEvidence')({...legacy,evidence:'text'})),{status:'unknown',note:'declared_source_not_verified'});
const kept=plain(call('predictionDiagnosticValidation')({stage:'fingerprint_schema',reportedBy:'worker',issues:[{path:'fingerprint.evidence.execution.payoff',code:'invalid_ref'},{path:'fingerprint.evidence.execution.payoff.extra',code:'invalid_ref'},{path:'fingerprint.evidence note',code:'invalid_ref'}]}));
assert.deepEqual(kept.issues,[{path:'fingerprint.evidence.execution.payoff',code:'invalid_ref'}]);

function boot(ids){records.clear();etags.clear();revision=0;records.set('enrichment/profile/current.json',{version:1,profileHash:'p',profile:{ratingScale:'Half stars'}});records.set('sync.json',{runId:'test',stage:'complete'});const catalog={};for(const id of ids)catalog[id]={id,title:'Heat '+id,original:id,year:1995,tmdbId:id.replace(/\D/g,''),genres:['Crime'],synopsis:'A crew plans a robbery.',directors:['Michael Mann'],actors:['Al Pacino'],runtime:170,shows:[{start:Date.now()}]};records.set('programme.json',{runId:'test',films:[]});records.set('epg/discovered-films.json',catalog);}
const prediction={predictedRating:3.5,probability4Plus:.45,confidence:'medium',matchSignals:['Heist'],mainRisk:'Mixed payoff',moodLabels:['мрачный','напряжённый']};
boot(['tmdb_461','tmdb_462','tmdb_463']);
const start=(await api('start',{scope:'watchlist_all',mode:'queued'})).data;
const ids=(await api('next',{runId:start.runId,batchSize:3})).data.items.map(item=>item.filmId);
const submit=body=>api('submit',{runId:start.runId,items:[body]});
let result=(await submit({filmId:ids[0],fingerprint:legacy,prediction})).data;
assert.equal(result.results[0].status,'created');
const legacyBody=records.get('enrichment/films/'+ids[0]+'/fingerprints/'+records.get('enrichment/films/'+ids[0]+'/fingerprint.json').fingerprintHash+'.json');
assert.equal(Object.hasOwn(legacyBody,'evidence'),false);
assert.equal(await call('contentHash')({...legacy,filmId:ids[0]}),legacyBody.fingerprintHash);
result=(await submit({filmId:ids[1],fingerprint:heistOnly,prediction})).data;
assert.equal(result.results[0].status,'created',JSON.stringify(result.results[0]));
const storedPointer=records.get('enrichment/films/'+ids[1]+'/fingerprint.json');
const storedBody=records.get('enrichment/films/'+ids[1]+'/fingerprints/'+storedPointer.fingerprintHash+'.json');
assert.deepEqual(storedBody.evidence,heistOnly.evidence);
assert.equal(storedBody.fingerprintHash,await call('contentHash')({...heistOnly,filmId:ids[1]}));
assert.equal(Object.hasOwn(records.get('enrichment/view-index.json')[ids[1]].impactFeatures,'evidence'),false);
assert.equal(call('fingerprintCurrent')(storedPointer),true);
result=(await submit({filmId:ids[2],fingerprint:payoffOnly,prediction})).data;
assert.equal(result.results[0].status,'retryable_failure');
assert.equal(result.results[0].validation.stage,'fingerprint_schema');
assert.ok(result.results[0].validation.issues.some(issue=>issue.path==='fingerprint.evidence.execution.payoff'&&issue.code==='invalid_ref'));
assert.equal(records.has('enrichment/films/'+ids[2]+'/fingerprint.json'),false);

const proposal=fs.readFileSync('docs/reference/scheduled-tasks.md','utf8');
assert.match(proposal,/### Fingerprint evidence instruction in the live hourly task \(AIR-335, 2026-11-03\)/);
assert.doesNotMatch(proposal,/### Proposed fingerprint evidence instruction \(not applied\)/);
assert.match(proposal,/Live state, not merely a proposal/);
assert.match(proposal,/Mutable prediction state/);
assert.match(proposal,/On `prediction_only`, reuse the existing Worker fingerprint/);
assert.match(proposal,/Do not invent a URL/);
assert.match(proposal,/Metadata does not support an execution-quality claim/);
assert.match(proposal,/Keep `FINGERPRINT_SCHEMA_VERSION=1`, `FINGERPRINT_PROMPT_VERSION=1`, `PREDICTION_PROMPT_VERSION=1` and `FINGERPRINT_TRANSITIONS=\[\]`/);
assert.doesNotMatch(proposal,/### Future fingerprint evidence instruction \(not active\)/);
assert.equal(JSON.stringify(call('predictionRunnerContract')().instructions).includes('fingerprint.evidence'),false);
assert.equal(call('schemaContract')().fingerprint.evidence.required,false);

const prompted=withEvidence({
 execution:{plot_engine:'strong',decision_logic:'strong',technical_plausibility:'not_applicable'},
 evidence:{plotMechanics:{heist:[item('metadata',['metadata:synopsis','metadata:genres'])]},execution:{plot_engine:[item('model_knowledge',['model_knowledge'],'high')],decision_logic:[item('model_knowledge',['model_knowledge'],'medium')]}},
 sourceBasis:'mixed',
 sourceRefs:['metadata:synopsis','metadata:genres','model_knowledge']
});
assert.deepEqual(issuesOf(prompted,metadata),[],'a fingerprint that follows the live Stage B rules is valid');
assert.equal(Object.hasOwn(prompted.evidence.execution,'pace'),false);
assert.equal(Object.hasOwn(prompted.evidence.execution,'technical_plausibility'),false);
assert.deepEqual(issuesOf(legacy),[],'prediction_only still omits the map');

const vocabulary={mechanics:plain(call('MECHANICS')),execution:plain(call('EXECUTION')),general:plain(call('GENERAL_EXECUTION')),domains:{}};
const options={vocabulary,digest:()=>'unused'};
const stored={...legacy,fingerprintPromptVersion:1};
const sameTarget={fingerprintSchemaVersion:1,fingerprintPromptVersion:1};
const nextPrompt={fingerprintSchemaVersion:1,fingerprintPromptVersion:2};
assert.equal(call('fingerprintCompatibility')(stored,{genres:['Crime']},[],sameTarget,'selective',options).outcome,'current');
const missing=call('fingerprintCompatibility')(stored,{genres:['Crime']},[],nextPrompt,'selective',options);
assert.equal(missing.outcome,'stale');
assert.equal(missing.reason,'transition_unknown');
assert.equal(missing.migration,'global','a prompt bump with an empty registry re-queues every film');
const globalBump=[{transitionSchemaVersion:1,axis:'fingerprint_prompt',from:1,to:2,scope:'global',changes:[{kind:'prompt_revised'}],selectors:[]}];
const globalVerdict=call('fingerprintCompatibility')(stored,{genres:['Crime']},globalBump,nextPrompt,'selective',options);
assert.equal(globalVerdict.reason,'transition_global');
assert.equal(globalVerdict.migration,'global');
assert.equal(call('fingerprintTransitionIssue')({transitionSchemaVersion:1,axis:'fingerprint_prompt',from:1,to:2,scope:'identity',changes:[{kind:'prompt_revised'}],selectors:[]},null,vocabulary,()=>'unused'),'identity_change_not_compatible');

console.log('fingerprint evidence: optional map, aggregate, metadata facts, legacy hash and submit passed');
