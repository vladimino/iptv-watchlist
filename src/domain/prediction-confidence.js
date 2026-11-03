// Deterministic evidence confidence for one fingerprint (AIR-19). Pure: no I/O, no clock, no randomness,
// and no read of a rating, a model prediction or the derived aggregate basis. The result is not part of fingerprintHash.
// Nothing in the Worker calls this; attaching it to a stored prediction is a later card.
const CONFIDENCE_ASSESSMENT_VERSION=1;
const CONFIDENCE_LEVELS=['low','medium','high'];
const CONFIDENCE_STATUSES=['evidenced','legacy','insufficient'];
const ITEM_CONFIDENCE=['low','medium','high'];
const ITEM_BASIS=['metadata','model_knowledge','web_research'];
const METADATA_REFS=['metadata:synopsis','metadata:genres','metadata:runtime','metadata:credits'];
const CONFIDENCE_MECHANICS=['heist','scam','investigation','mystery','chase_escape','rescue','escort_protection','survival','siege','ticking_clock','expedition_discovery','puzzle','plan_counterplan','multi_party_conflict'];
const EXECUTION_VOCABULARY={plot_engine:['weak','medium','strong','unknown'],pace:['slow','medium','fast','variable','unknown'],stakes:['low','medium','high','unknown'],decision_logic:['weak','mixed','strong','unknown'],protagonist_competence:['low','mixed','high','unknown'],opposition_competence:['low','mixed','high','not_applicable','unknown'],problem_solving:['weak','medium','strong','unknown'],plan_counterplan_strength:['none','weak','medium','strong','unknown'],multi_party_goals:['none','weak','medium','strong','unknown'],chemistry:['weak','medium','strong','unknown'],payoff:['weak','mixed','strong','unknown'],ending_quality:['weak','mixed','strong','unknown'],technical_plausibility:['weak','mixed','strong','not_applicable','unknown'],action_readability:['weak','mixed','strong','unknown'],hero_vulnerability:['low','mixed','high','unknown'],comedy_stupidity_for_gags:['low','mixed','high','unknown'],comedy_gross_out:['low','mixed','high','unknown'],horror_rule_consistency:['weak','mixed','strong','unknown'],horror_threat_causality:['weak','mixed','strong','unknown'],scifi_plot_driven_concept:['weak','medium','strong','unknown'],adventure_discovery_strength:['weak','medium','strong','unknown']};
// Schema-1 general dimensions. Pace and stakes are in this set with the dimensions the card names:
// a gap in either one counts. Genre dimensions stay outside it.
const KEY_EXECUTION=['plot_engine','pace','stakes','decision_logic','protagonist_competence','opposition_competence','problem_solving','plan_counterplan_strength','multi_party_goals','chemistry','payoff','ending_quality','technical_plausibility'];
const GENRE_EXECUTION=Object.keys(EXECUTION_VOCABULARY).filter(key=>!KEY_EXECUTION.includes(key));
const CONFIDENCE_ASSESSMENT_THRESHOLDS={highUnknownMax:2,highSupportedMin:8,mediumSupportedMin:4};
const REASON_ORDER=['legacy_no_evidence','evidence_unusable','unsupported_schema','evidence_shape','metadata_only_execution','metadata_mechanic','declared_source_not_verified','low_item_confidence','duplicate_ref','unknown_gap','no_asserted_mechanics','partial_mechanic_coverage','partial_execution_coverage','key_coverage_complete','not_applicable_excluded','genre_optional'];
const confidencePlain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const emptyCoverage=()=>({mechanicsAsserted:0,mechanicsSupported:0,keyApplicable:0,keyConcrete:0,keySupported:0,keyUnknown:0,keyNotApplicable:0,genrePresent:0,genreSupported:0});
function confidenceHash(fingerprint){const value=fingerprint&&fingerprint.fingerprintHash;return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:null;}
function confidenceReasons(reasons){return REASON_ORDER.filter(code=>reasons.has(code));}
function confidenceResult(level,status,reasons,coverage,hash){
 return {assessmentVersion:CONFIDENCE_ASSESSMENT_VERSION,level:status==='evidenced'?level:'low',status,reasonCodes:confidenceReasons(reasons),coverage,fingerprintHash:hash};
}
function evidenceUrlOk(value){
 if(typeof value!=='string'||value.length>500)return false;
 let url;try{url=new URL(value);}catch{return false;}
 if(url.protocol!=='https:'||url.username||url.password)return false;
 const host=url.hostname.toLowerCase().replace(/^\[|\]$/g,'');
 if(!host||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||host==='0.0.0.0'||host==='::1'||host==='::')return false;
 if(/^\d{1,3}(\.\d{1,3}){3}$/.test(host)){
  const parts=host.split('.').map(Number);
  if(parts.some(part=>part>255))return false;
  const [a,b]=parts;
  if(a===0||a===10||a===127||(a===192&&b===168)||(a===172&&b>=16&&b<=31)||(a===169&&b===254))return false;
 }
 if(host.includes(':')){
  const mapped=/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
  if(mapped)return evidenceUrlOk('https://'+mapped[1]+'/');
  const head=host.split(':').find(Boolean)||'';
  if(/^f[cd]/i.test(head)||/^fe[89ab]/i.test(head))return false;
 }
 return true;
}
function confidenceItem(item){
 if(!confidencePlain(item))return null;
 if(Object.keys(item).some(key=>key!=='basis'&&key!=='refs'&&key!=='confidence'))return null;
 if(!ITEM_BASIS.includes(item.basis)||!ITEM_CONFIDENCE.includes(item.confidence))return null;
 if(!Array.isArray(item.refs)||item.refs.length<1||item.refs.length>4||item.refs.some(ref=>typeof ref!=='string'))return null;
 if(new Set(item.refs).size!==item.refs.length)return null;
 if(item.basis==='metadata'&&item.refs.some(ref=>!METADATA_REFS.includes(ref)))return null;
 if(item.basis==='model_knowledge'&&(item.refs.length!==1||item.refs[0]!=='model_knowledge'))return null;
 if(item.basis==='web_research'&&item.refs.some(ref=>!evidenceUrlOk(ref)))return null;
 return item;
}
// A claim's support is the weakest accepted item. A repeated ref drops that one step. Metadata items do not
// support an execution dimension; they can support a mechanic.
function claimSupport(list,reasons,qualityOnly){
 if(!Array.isArray(list)||list.length<1||list.length>4){reasons.add('evidence_shape');return null;}
 const seen=new Set(),accepted=[];let duplicate=false,declared=false;
 for(const raw of list){
  if(confidencePlain(raw)&&Array.isArray(raw.refs)&&new Set(raw.refs).size!==raw.refs.length){duplicate=true;reasons.add('evidence_shape');}
  const item=confidenceItem(raw);
  if(!item){reasons.add('evidence_shape');continue;}
  for(const ref of item.refs){if(seen.has(item.basis+':'+ref))duplicate=true;seen.add(item.basis+':'+ref);}
  if(item.basis!=='metadata')declared=true;
  accepted.push(item);
 }
 if(duplicate)reasons.add('duplicate_ref');
 const usable=qualityOnly?accepted.filter(item=>item.basis!=='metadata'):accepted;
 if(qualityOnly&&accepted.length&&!usable.length)reasons.add('metadata_only_execution');
 if(!qualityOnly&&accepted.length&&accepted.every(item=>item.basis==='metadata'))reasons.add('metadata_mechanic');
 if(declared)reasons.add('declared_source_not_verified');
 if(!usable.length)return null;
 const order=['low','medium','high'];
 let rank=Math.min(...usable.map(item=>order.indexOf(item.confidence)));
 if(duplicate)rank=Math.max(0,rank-1);
 return order[rank];
}
function levelFor(reasons,counts){
 const {mechanicsAsserted,mechanicsSupported,keySupported,keyConcrete,keyHigh,keyUnknown,keyApplicable,keyLow}=counts;
 const blocked=reasons.has('evidence_shape')||reasons.has('duplicate_ref')||reasons.has('metadata_only_execution');
 const high=!blocked&&mechanicsAsserted>=1&&mechanicsSupported===mechanicsAsserted&&keySupported===keyConcrete&&keyConcrete>=CONFIDENCE_ASSESSMENT_THRESHOLDS.highSupportedMin&&keyHigh>=CONFIDENCE_ASSESSMENT_THRESHOLDS.highSupportedMin&&keyUnknown<=CONFIDENCE_ASSESSMENT_THRESHOLDS.highUnknownMax&&keyLow===0;
 if(high)return 'high';
 const medium=mechanicsAsserted>=1&&mechanicsSupported*2>=mechanicsAsserted&&keySupported>=CONFIDENCE_ASSESSMENT_THRESHOLDS.mediumSupportedMin&&keySupported*2>=keyConcrete&&keyUnknown*2<=keyApplicable&&keyLow*2<=keySupported;
 return medium?'medium':'low';
}
function assessPredictionConfidence(fingerprint){
 const hash=confidenceHash(fingerprint),reasons=new Set();
 if(!confidencePlain(fingerprint))return confidenceResult('low','insufficient',reasons.add('evidence_unusable'),emptyCoverage(),null);
 if(Object.hasOwn(fingerprint,'fingerprintSchemaVersion')&&fingerprint.fingerprintSchemaVersion!==1)return confidenceResult('low','insufficient',reasons.add('unsupported_schema'),emptyCoverage(),hash);
 if(!Object.hasOwn(fingerprint,'evidence'))return confidenceResult('low','legacy',reasons.add('legacy_no_evidence'),emptyCoverage(),hash);
 const evidence=fingerprint.evidence;
 if(!confidencePlain(evidence))return confidenceResult('low','insufficient',reasons.add('evidence_unusable'),emptyCoverage(),hash);
 if(Object.keys(evidence).some(key=>key!=='plotMechanics'&&key!=='execution'))reasons.add('evidence_shape');
 const mechanics=Array.isArray(fingerprint.plotMechanics)?fingerprint.plotMechanics:[];
 const asserted=[];
 for(const name of mechanics){
  if(!CONFIDENCE_MECHANICS.includes(name)){reasons.add('evidence_shape');continue;}
  if(!asserted.includes(name))asserted.push(name);
 }
 const mechanicMap=confidencePlain(evidence.plotMechanics)?evidence.plotMechanics:null;
 if(Object.hasOwn(evidence,'plotMechanics')&&!mechanicMap)reasons.add('evidence_shape');
 let mechanicsSupported=0;
 for(const name of asserted){
  const support=mechanicMap?claimSupport(mechanicMap[name],reasons,false):null;
  if(!mechanicMap||!Object.hasOwn(mechanicMap,name)||!support)reasons.add('evidence_shape');
  if(support)mechanicsSupported++;
 }
 if(mechanicMap)for(const name of Object.keys(mechanicMap))if(!asserted.includes(name))reasons.add('evidence_shape');
 const execution=confidencePlain(fingerprint.execution)?fingerprint.execution:{};
 if(Object.hasOwn(fingerprint,'execution')&&!confidencePlain(fingerprint.execution))reasons.add('evidence_shape');
 const executionMap=confidencePlain(evidence.execution)?evidence.execution:null;
 if(Object.hasOwn(evidence,'execution')&&!executionMap)reasons.add('evidence_shape');
 const counts={mechanicsAsserted:asserted.length,mechanicsSupported,keyApplicable:0,keyConcrete:0,keySupported:0,keyUnknown:0,keyNotApplicable:0,keyHigh:0,keyLow:0,genrePresent:0,genreSupported:0};
 for(const key of KEY_EXECUTION){
  const value=execution[key],known=EXECUTION_VOCABULARY[key].includes(value);
  if(value==='not_applicable'){counts.keyNotApplicable++;if(executionMap&&Object.hasOwn(executionMap,key))reasons.add('evidence_shape');continue;}
  counts.keyApplicable++;
  if(!known||value==='unknown'){counts.keyUnknown++;if(executionMap&&Object.hasOwn(executionMap,key))reasons.add('evidence_shape');continue;}
  counts.keyConcrete++;
  const support=executionMap&&Object.hasOwn(executionMap,key)?claimSupport(executionMap[key],reasons,true):null;
  if(!support){if(!executionMap||!Object.hasOwn(executionMap,key))reasons.add('evidence_shape');continue;}
  counts.keySupported++;
  if(support==='high')counts.keyHigh++;
  if(support==='low')counts.keyLow++;
 }
 if(executionMap)for(const key of Object.keys(executionMap))if(!Object.hasOwn(EXECUTION_VOCABULARY,key))reasons.add('evidence_shape');
 let genreSeen=false;
 for(const key of GENRE_EXECUTION){
  if(!Object.hasOwn(execution,key))continue;
  genreSeen=true;
  const value=execution[key],known=EXECUTION_VOCABULARY[key].includes(value);
  if(!known||value==='unknown'){if(executionMap&&Object.hasOwn(executionMap,key))reasons.add('evidence_shape');continue;}
  counts.genrePresent++;
  const support=executionMap&&Object.hasOwn(executionMap,key)?claimSupport(executionMap[key],reasons,true):null;
  if(support)counts.genreSupported++;
  else if(executionMap&&Object.hasOwn(executionMap,key))reasons.add('evidence_shape');
 }
 if(genreSeen)reasons.add('genre_optional');
 if(counts.mechanicsAsserted===0)reasons.add('no_asserted_mechanics');
 if(counts.mechanicsAsserted>0&&counts.mechanicsSupported<counts.mechanicsAsserted)reasons.add('partial_mechanic_coverage');
 if(counts.keyConcrete>0&&counts.keySupported<counts.keyConcrete)reasons.add('partial_execution_coverage');
 if(counts.keyConcrete>0&&counts.keySupported===counts.keyConcrete)reasons.add('key_coverage_complete');
 if(counts.keyUnknown>0)reasons.add('unknown_gap');
 if(counts.keyNotApplicable>0)reasons.add('not_applicable_excluded');
 if(counts.keyLow>0)reasons.add('low_item_confidence');
 const coverage={mechanicsAsserted:counts.mechanicsAsserted,mechanicsSupported:counts.mechanicsSupported,keyApplicable:counts.keyApplicable,keyConcrete:counts.keyConcrete,keySupported:counts.keySupported,keyUnknown:counts.keyUnknown,keyNotApplicable:counts.keyNotApplicable,genrePresent:counts.genrePresent,genreSupported:counts.genreSupported};
 if(!mechanicsSupported&&!counts.keySupported){
  reasons.add('evidence_unusable');
  return confidenceResult('low','insufficient',reasons,coverage,hash);
 }
 return confidenceResult(levelFor(reasons,counts),'evidenced',reasons,coverage,hash);
}
function presentConfidenceAssessment(value){
 if(!confidencePlain(value)||value.assessmentVersion!==CONFIDENCE_ASSESSMENT_VERSION)return null;
 if(!CONFIDENCE_LEVELS.includes(value.level)||!CONFIDENCE_STATUSES.includes(value.status))return null;
 if(value.status!=='evidenced'&&value.level!=='low')return null;
 if(!Array.isArray(value.reasonCodes)||!confidencePlain(value.coverage))return null;
 const reasonCodes=REASON_ORDER.filter(code=>value.reasonCodes.includes(code));
 const coverage={};
 for(const key of Object.keys(emptyCoverage())){
  const number=value.coverage[key];
  if(typeof number!=='number'||!Number.isInteger(number)||number<0||number>99)return null;
  coverage[key]=number;
 }
 const fingerprintHash=typeof value.fingerprintHash==='string'&&/^[a-f0-9]{64}$/.test(value.fingerprintHash)?value.fingerprintHash:null;
 return {assessmentVersion:CONFIDENCE_ASSESSMENT_VERSION,level:value.level,status:value.status,reasonCodes,coverage,fingerprintHash};
}
