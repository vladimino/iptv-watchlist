
// Versioned derived vocabulary: source fingerprints/predictions and their hashes stay immutable.
const MOOD_MAPPING_VERSION=1;
const MOOD_LABELS={tense:'Напряжённый',dark:'Мрачный',light:'Лёгкий',adventurous:'Приключенческий',dynamic:'Динамичный',epic:'Масштабный',violent:'Жёсткий',funny:'Комедийный',black_humor:'Чёрный юмор',satirical:'Сатирический',absurd:'Абсурдный',romantic:'Романтический',warm:'Тёплый',touching:'Трогательный',inspiring:'Вдохновляющий',melancholic:'Меланхоличный',tragic:'Трагический',contemplative:'Созерцательный',surreal:'Сюрреалистический',eerie:'Мистический / пугающий',paranoid:'Параноидальный',noir:'Нуарный',military:'Военная тема',historical:'Историческая тема',family:'Семья и отношения',friendship:'Дружба и команда',political:'Политика и общество',revenge:'Месть и возмездие'};
function normalizeRawMood(value){return typeof value==='string'?value.normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim():'';}
const MOOD_RULES=[
 ['tense',/напряж|тревож|нервн|стресс|tense|suspense/],['dark',/мрач|темн|безысход|холодн|безнадеж|dark|bleak/],['light',/легк|светл|несерьез|lighthearted/],['adventurous',/приключ|авантюр|adventur/],['dynamic',/динамич|драйв|энергич|бодр|dynamic/],['epic',/масштаб|эпичес|эпос|эпопе|зрелищ|epic/],['violent',/жестк|жесток|кровав|брутал|агрессив|насили|violent/],['funny',/комеди|юмор|забав|смешн|comedy|funny/],['black_humor',/черн[^ ]* (?:криминальн[^ ]* )?(?:комеди|юмор)|black comedy|dark humor/],['satirical',/сатир|ирони|цинич|satir/],['absurd',/абсурд|гротеск|фарс|дураш|безумн|absurd/],['romantic',/романти|любов|страст|страсть|эротич|romantic/],['warm',/тепл|уют|рождеств|празднич|добродуш|warm/],['touching',/трогат|лирич|эмоциональн|touching/],['inspiring',/вдохнов|воодушев|исцелен|искуплен|inspir/],['melancholic',/меланхол|ностальг|скорб|melanchol/],['tragic',/трагич|трагед|неизбежн[^ ]* (?:гибель|смерть)|tragic/],['contemplative',/созерц|медитатив|философ|contemplative/],['surreal',/сюрреал|сновид|галлюцин|surreal/],['eerie',/мистич|паранорм|оккульт|готич|проклят|демон|ведьм|потусторон|экзорц|хоррор|ужас|horror|eerie/],['paranoid',/парано|недовер|ненадежн[^ ]* реальн|paranoid/],['noir',/нуар|noir/],['military',/военн|войн|фронт|армад|солдат|морпех|воинск|танков|партизан|military|war /],['historical',/историч|средневек|антич|костюмн|ретро|библейск|historical/],['family',/семь|семейн|родител|материн|отец и|отца|отцов|сын(?: |$)|дочь|дочер|брач|брак|сестрин|братск|family/],['friendship',/дружб|друз|команд|братств|наставник|наставнич|buddy|friendship/],['political',/политич|политик|социальн|тоталитар|антиутоп|общество|коррупц|революц|politic/],['revenge',/месть|возмезд|revenge/]
];
const MOOD_IGNORED=/^(?:осада|погоня|побег|спасение|выживание|расследование|загадка|тайна|ограбление|ограбления|афера|охота|защита|экспедиция|квест|похищение|эскорт|операция|миссия|план|противостояние|головоломки?|гонка со временем|ticking clock|survival|heist|cat and mouse|кошки мышки)$/;
function mapRawMood(raw){const normalized=normalizeRawMood(raw);if(Object.hasOwn(MOOD_LABELS,raw))return {raw,normalized,ids:[raw],status:'mapped'};const ids=MOOD_RULES.filter(([,pattern])=>pattern.test(normalized)).map(([id])=>id);return {raw,normalized,ids,status:ids.length?'mapped':MOOD_IGNORED.test(normalized)?'mechanic_only':'unmapped'};}
function canonicalMoodFacet(fingerprint,prediction){const rawLabels=[...new Set([...(fingerprint?.moodLabels||[]),...(prediction?.moodLabels||[])])],mapping=rawLabels.map(mapRawMood);return {mappingVersion:MOOD_MAPPING_VERSION,rawLabels,moodIds:[...new Set(mapping.flatMap(m=>m.ids))].sort(),mapping,unmapped: mapping.filter(m=>m.status==='unmapped').map(m=>m.raw)};}
function moodDiagnostics(index){const raw=new Map(),canonicalCounts={};let films=0;for(const item of Object.values(index||{})){const facet=canonicalMoodFacet(item.fingerprint,item.prediction);if(!facet.rawLabels.length)continue;films++;for(const id of facet.moodIds)canonicalCounts[id]=(canonicalCounts[id]||0)+1;for(const m of facet.mapping){const entry=raw.get(m.raw)||{...m,filmCount:0};entry.filmCount++;raw.set(m.raw,entry);}}const mappings=[...raw.values()].sort((a,b)=>b.filmCount-a.filmCount||a.raw.localeCompare(b.raw,'ru'));return {mappingVersion:MOOD_MAPPING_VERSION,vocabulary:MOOD_LABELS,films,rawVariants:mappings.length,canonicalOptions:Object.keys(canonicalCounts).length,canonicalCounts,mappings,unmapped:mappings.filter(m=>m.status==='unmapped'),mechanicOnly:mappings.filter(m=>m.status==='mechanic_only')};}
async function moodBackfill(env,body){if(body.limit!==undefined&&(!Number.isInteger(body.limit)||body.limit<1||body.limit>100))return json({error:'Invalid limit'},400);const cursor=body.cursor||undefined;if(cursor&&typeof cursor!=='string')return json({error:'Invalid cursor'},400);const page=await env.BUCKET.list({prefix:ENRICHMENT_KEY+'films/',limit:Math.min(body.limit||12,12),...(cursor?{cursor}:{})});const ids=[...new Set(page.objects.filter(o=>/\/(fingerprint|predictions)\.json$/.test(o.key)).map(o=>decodeURIComponent(o.key.split('/')[2])))];const patches=await Promise.all(ids.map(async id=>{const state=await readFilmState(env,id),facet={...canonicalMoodFacet(state.fingerprint,state.predictions?.current),historyMoodFacets:(state.predictions?.history||[]).map(p=>({generatedAt:p.generatedAt||null,...canonicalMoodFacet(null,p)}))};await saveJSON(env,filmKey(id)+'mood-facet.json',facet);return {id,fingerprint:state.fingerprint,prediction:state.predictions?.current,facet};}));const index=await mergeStoredJSON(env,ENRICHMENT_KEY+'view-index.json',{},current=>{if(!patches.length)return null;for(const patch of patches)current[patch.id]={...(current[patch.id]||{}),...(patch.fingerprint?{fingerprintHash:patch.fingerprint.fingerprintHash,fingerprint:fingerprintFacet(patch.fingerprint),impactFeatures:fingerprintImpactFacet(patch.fingerprint)}:{}),...(patch.prediction?{prediction:patch.prediction}:{}),moodFacet:patch.facet};return current;});const result={mappingVersion:MOOD_MAPPING_VERSION,checked:ids.length,nextCursor:page.truncated?page.cursor:null,done:!page.truncated};if(result.done)await saveJSON(env,ENRICHMENT_KEY+'diagnostics/moods.json',{...moodDiagnostics(index),completedAt:new Date().toISOString()});return json(result);}

// Independent R2 namespace: no enrichment write touches programme, watchlist or sync.
const FINGERPRINT_SCHEMA_VERSION=1;
const FINGERPRINT_PROMPT_VERSION=1;
const PREDICTION_PROMPT_VERSION=1;
// ADR-0035 section 3: the append-only transition registry, one contiguous chain per axis from version 1. A version constant
// above changes only together with its declaration here; the registry is empty until the first declared transition.
const FINGERPRINT_TRANSITIONS=[];
// The fingerprint vocabulary of schema version 1, frozen: the base the evaluator derives every later schema from by applying
// the registry. MECHANICS, EXECUTION, GENERAL_EXECUTION and PROFILE_GENRE_DOMAINS below stay the live contract of the
// current schema; a test checks that the registry applied to this base reproduces them.
const FINGERPRINT_SCHEMA_BASE={"mechanics":["heist","scam","investigation","mystery","chase_escape","rescue","escort_protection","survival","siege","ticking_clock","expedition_discovery","puzzle","plan_counterplan","multi_party_conflict"],"execution":{"plot_engine":["weak","medium","strong","unknown"],"pace":["slow","medium","fast","variable","unknown"],"stakes":["low","medium","high","unknown"],"decision_logic":["weak","mixed","strong","unknown"],"protagonist_competence":["low","mixed","high","unknown"],"opposition_competence":["low","mixed","high","not_applicable","unknown"],"problem_solving":["weak","medium","strong","unknown"],"plan_counterplan_strength":["none","weak","medium","strong","unknown"],"multi_party_goals":["none","weak","medium","strong","unknown"],"chemistry":["weak","medium","strong","unknown"],"payoff":["weak","mixed","strong","unknown"],"ending_quality":["weak","mixed","strong","unknown"],"technical_plausibility":["weak","mixed","strong","not_applicable","unknown"],"action_readability":["weak","mixed","strong","unknown"],"hero_vulnerability":["low","mixed","high","unknown"],"comedy_stupidity_for_gags":["low","mixed","high","unknown"],"comedy_gross_out":["low","mixed","high","unknown"],"horror_rule_consistency":["weak","mixed","strong","unknown"],"horror_threat_causality":["weak","mixed","strong","unknown"],"scifi_plot_driven_concept":["weak","medium","strong","unknown"],"adventure_discovery_strength":["weak","medium","strong","unknown"]},"general":["plot_engine","pace","stakes","decision_logic","protagonist_competence","opposition_competence","problem_solving","plan_counterplan_strength","multi_party_goals","chemistry","payoff","ending_quality","technical_plausibility"],"domains":{"comedy_stupidity_for_gags":["comedy"],"comedy_gross_out":["comedy"],"horror_rule_consistency":["horror"],"horror_threat_causality":["horror"],"scifi_plot_driven_concept":["science_fiction"],"adventure_discovery_strength":["adventure"],"action_readability":["action"],"hero_vulnerability":["action"]}};
// The fingerprint transition rule (ADR-0035) always decides fingerprint freshness: the former
// PREDICTION_FINGERPRINT_COMPATIBILITY switch is retired (ADR 0047) and a stale binding is inert. The strict outcome (exact
// schema and prompt equality) is still evaluated and counted beside the decision; D1 and the benchmark stay strict by contract.
const PREDICTION_FINGERPRINT_MODE='selective';
// At most this share of a batch (rounded up) goes to migration work, films that have a prediction but need a fingerprint or
// prediction regenerated by a declared transition; missing work fills the rest (ADR-0035 section 6).
const FINGERPRINT_MIGRATION_SHARE=.5;
const ENRICHMENT_KEY='enrichment/';
const filmKey=id=>ENRICHMENT_KEY+'films/'+encodeURIComponent(String(id))+'/';
const profileKey=ENRICHMENT_KEY+'profile/current.json';
const runKey=id=>ENRICHMENT_KEY+'runs/'+id+'.json';
const diagnosticSnapshotKey=ENRICHMENT_KEY+'diagnostics/baseline.json';
const ratingObservationsKey=ENRICHMENT_KEY+'diagnostics/rating-observations.json';
const predictionQueueKey=ENRICHMENT_KEY+'prediction-queue.json';
const isObject=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const isText=(x,max=500)=>typeof x==='string'&&x.trim().length>0&&x.length<=max;
const isTextList=(x,max=30)=>Array.isArray(x)&&x.length<=max&&x.every(v=>isText(v));
const oneOf=(x,values)=>values.includes(x);
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(isObject(value))return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
async function contentHash(value){const bytes=new TextEncoder().encode(JSON.stringify(canonical(value)));return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');}
function validateProfile(p){
 if(!isObject(p))return 'profile must be an object';
 for(const key of ['ratingScale','positiveSignals','negativeSignals','characterLogic','pace','payoffEnding','genrePreferences','comedyPreferences','horrorPreferences','scifiAdventurePreferences','actionPreferences','anchorFilms','hardSkips','calibration'])if(!(key in p))return 'Missing '+key;
 if(!isText(p.ratingScale,1000)||!isText(p.characterLogic,2000)||!isText(p.pace,2000)||!isText(p.payoffEnding,2000)||!isText(p.calibration,3000))return 'Invalid rating scale or guidance';
 for(const key of ['positiveSignals','negativeSignals','hardSkips'])if(!isTextList(p[key],50))return 'Invalid '+key;
 for(const key of ['genrePreferences','comedyPreferences','horrorPreferences','scifiAdventurePreferences','actionPreferences'])if(!isText(p[key],3000))return 'Invalid '+key;
 if(!Array.isArray(p.anchorFilms)||p.anchorFilms.length>100||p.anchorFilms.some(a=>!isObject(a)||!isText(a.title,200)||!Number.isFinite(a.rating)||a.rating<.5||a.rating>5||a.rating*2%1!==0||!isText(a.reason,1000)))return 'Invalid anchorFilms';
 if(JSON.stringify(p).length>60000)return 'Profile too large';return null;
}
// Taste-profile publication (ADR-0013, ADR-0031). Everything is validated before the first write; a rejection changes nothing.
// The version record is written create-only, then current.json moves by compare-and-swap on the ETag read at the start,
// so two concurrent publications cannot both become current and a version number is never rewritten.
const PROFILE_PUBLISH_STATUS={impact_missing:400,impact_schema_unknown:400,from_mismatch:409,scope_unknown:400,identity_requires_same_hash:400,changed_fields_mismatch:400,global_field_requires_global:400,selective_requires_selectors:400,selector_kind_unknown:400,selector_invalid:400,field_not_covered:400,genre_floor_missing:400,selective_requires_owner_approval:400,approval_mismatch:400};
async function publishProfile(env,body){
 if(body.dryRun!==undefined&&typeof body.dryRun!=='boolean')return json({error:'Invalid dryRun'},400);
 if(body.schemaVersion!==1||!Number.isInteger(body.version)||body.version<1)return json({error:'Invalid version or schemaVersion'},400);
 const issue=validateProfile(body.profile);if(issue)return json({error:issue},400);
 const stored=await env.BUCKET.get(profileKey),current=stored?await stored.json():null,currentEtag=stored?.etag||null;
 if(current&&body.version<=current.version)return json({error:'Version must increase',code:'version_not_increasing'},409);
 const profileHash=await contentHash(body.profile),next={version:body.version,profileHash},impact=body.changeImpact??null;
 let changedFields=profileChangedFields(null,body.profile),declarationSha256=null;
 if(current){
  const text=profileDeclarationText(impact,next);declarationSha256=text?await profileDeclarationHash(text):null;
  const checked=validateProfileImpact({previous:current,next:{...next,profile:body.profile},impact,declarationSha256,vocabulary:{mechanics:MECHANICS,execution:EXECUTION}});
  changedFields=checked.changedFields;
  if(!checked.ok)return json({error:'Invalid changeImpact',code:checked.code,changedFields,profileHash,declarationSha256},PROFILE_PUBLISH_STATUS[checked.code]||400);
 }else if(impact!=null)return json({error:'The first version has no predecessor',code:'from_mismatch',changedFields,profileHash},409);
 if(body.dryRun)return json({dryRun:true,valid:true,version:body.version,profileHash,changedFields,declarationSha256,from:current?{version:current.version,profileHash:current.profileHash}:null});
 const record={version:body.version,schemaVersion:1,updatedAt:new Date().toISOString(),profileHash,profile:body.profile,changeImpact:current?impact:null};
 const versionKey=ENRICHMENT_KEY+'profile/versions/'+body.version+'.json';
 let saved=record;
 if(await env.BUCKET.put(versionKey,JSON.stringify(record),{httpMetadata:{contentType:'application/json'},onlyIf:{etagDoesNotMatch:'*'}})===null){
  // A retry of the same publication finds its own record; any other record under this number is a conflict.
  const existing=await loadJSON(env,versionKey);
  if(!existing||existing.profileHash!==profileHash||JSON.stringify(canonical(existing.changeImpact??null))!==JSON.stringify(canonical(record.changeImpact)))return json({error:'Version record already exists',code:'version_exists'},409);
  saved=existing;
 }
 const value={...saved,lineage:profileLineage(current,saved)};
 const moved=await env.BUCKET.put(profileKey,JSON.stringify(value),{httpMetadata:{contentType:'application/json'},onlyIf:currentEtag?{etagMatches:currentEtag}:{etagDoesNotMatch:'*'}});
 if(moved===null)return json({error:'Current profile changed during publication; read it and publish again',code:'profile_changed'},409);
 try{await refreshPredictionQueue(env,await loadJSON(env,'programme.json'),'profile_updated');}catch{}
 return json(value);
}
async function profileDeclarationHash(text){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');}
const MECHANICS=['heist','scam','investigation','mystery','chase_escape','rescue','escort_protection','survival','siege','ticking_clock','expedition_discovery','puzzle','plan_counterplan','multi_party_conflict'];
const EXECUTION={plot_engine:['weak','medium','strong','unknown'],pace:['slow','medium','fast','variable','unknown'],stakes:['low','medium','high','unknown'],decision_logic:['weak','mixed','strong','unknown'],protagonist_competence:['low','mixed','high','unknown'],opposition_competence:['low','mixed','high','not_applicable','unknown'],problem_solving:['weak','medium','strong','unknown'],plan_counterplan_strength:['none','weak','medium','strong','unknown'],multi_party_goals:['none','weak','medium','strong','unknown'],chemistry:['weak','medium','strong','unknown'],payoff:['weak','mixed','strong','unknown'],ending_quality:['weak','mixed','strong','unknown'],technical_plausibility:['weak','mixed','strong','not_applicable','unknown'],action_readability:['weak','mixed','strong','unknown'],hero_vulnerability:['low','mixed','high','unknown'],comedy_stupidity_for_gags:['low','mixed','high','unknown'],comedy_gross_out:['low','mixed','high','unknown'],horror_rule_consistency:['weak','mixed','strong','unknown'],horror_threat_causality:['weak','mixed','strong','unknown'],scifi_plot_driven_concept:['weak','medium','strong','unknown'],adventure_discovery_strength:['weak','medium','strong','unknown']};
const GENERAL_EXECUTION=['plot_engine','pace','stakes','decision_logic','protagonist_competence','opposition_competence','problem_solving','plan_counterplan_strength','multi_party_goals','chemistry','payoff','ending_quality','technical_plausibility'];
const GENRE_EXECUTION=Object.keys(EXECUTION).filter(key=>!GENERAL_EXECUTION.includes(key));
// AIR-152: one declarative contract drives the submit validator and GET /api/enrichment/schema,
// so a caller can run the same checks before prediction_submit. Every rule value is a constant
// from this file; a rule never carries caller data.
const CONFIDENCE=['low','medium','high'],SOURCE_BASIS=['metadata','model_knowledge','web_research','mixed'];
const FINGERPRINT_MAX_CHARS=12000;
const FINGERPRINT_RULES={
 fingerprintSchemaVersion:{kind:'const',value:FINGERPRINT_SCHEMA_VERSION},
 plotMechanics:{kind:'enum_list',values:MECHANICS},
 execution:{kind:'enum_object',fields:EXECUTION,required:GENERAL_EXECUTION,optional:GENRE_EXECUTION},
 moodLabels:{kind:'text_list',minItems:2,maxItems:4,maxLength:45},
 strengths:{kind:'text_list',minItems:0,maxItems:8,maxLength:500},
 risks:{kind:'text_list',minItems:0,maxItems:8,maxLength:500},
 confidence:{kind:'enum',values:CONFIDENCE},
 sourceBasis:{kind:'enum',values:SOURCE_BASIS},
 sourceRefs:{kind:'ref_list',minItems:0,maxItems:8,maxLength:500,accept:['https://… URL','model_knowledge']},
};
const PREDICTION_RULES={
 predictedRating:{kind:'number',min:.5,max:5,step:.5},
 probability4Plus:{kind:'number',min:0,max:1},
 confidence:{kind:'enum',values:CONFIDENCE},
 matchSignals:{kind:'text_list',minItems:0,maxItems:3,maxLength:220},
 mainRisk:{kind:'text',maxLength:220,nullable:true},
 moodLabels:{kind:'text_list',minItems:2,maxItems:4,maxLength:45},
};
const ISSUE_CODES=['required','invalid_type','invalid_version','invalid_enum','too_few','too_many','empty','too_long','out_of_range','invalid_step','invalid_ref','too_large'];
const MAX_ISSUES=20;
// Returns [{path, code}] with path = <root>[.<field>[.<subfield>]] from the rule tables and code from ISSUE_CODES.
// Field order follows the rule table; a text-list item issue is reported once per field, without the item.
function ruleIssues(root,rules,value){
 const issues=[],add=(path,code)=>{if(issues.length<MAX_ISSUES)issues.push({path,code});};
 if(value===undefined){add(root,'required');return issues;}
 if(!isObject(value)){add(root,'invalid_type');return issues;}
 const textList=(path,x,rule)=>{if(x===undefined){add(path,'required');return;}if(!Array.isArray(x)){add(path,'invalid_type');return;}if(x.length<rule.minItems)add(path,'too_few');else if(x.length>rule.maxItems)add(path,'too_many');if(x.some(v=>typeof v!=='string'))add(path,'invalid_type');else if(x.some(v=>!v.trim().length))add(path,'empty');else if(x.some(v=>v.length>rule.maxLength))add(path,'too_long');};
 for(const [field,rule] of Object.entries(rules)){const path=root+'.'+field,x=value[field];
  if(rule.kind==='const'){if(x===undefined)add(path,'required');else if(x!==rule.value)add(path,'invalid_version');}
  else if(rule.kind==='enum'){if(x===undefined)add(path,'required');else if(typeof x!=='string')add(path,'invalid_type');else if(!rule.values.includes(x))add(path,'invalid_enum');}
  else if(rule.kind==='enum_list'){if(x===undefined)add(path,'required');else if(!Array.isArray(x))add(path,'invalid_type');else if(x.some(v=>typeof v!=='string'))add(path,'invalid_type');else if(x.some(v=>!rule.values.includes(v)))add(path,'invalid_enum');}
  else if(rule.kind==='enum_object'){if(x===undefined){add(path,'required');continue;}if(!isObject(x)){add(path,'invalid_type');continue;}for(const [key,values] of Object.entries(rule.fields)){const v=x[key];if(v===undefined){if(rule.required.includes(key))add(path+'.'+key,'required');}else if(typeof v!=='string')add(path+'.'+key,'invalid_type');else if(!values.includes(v))add(path+'.'+key,'invalid_enum');}}
  else if(rule.kind==='text_list')textList(path,x,rule);
  else if(rule.kind==='ref_list'){if(x===undefined)add(path,'required');else if(!Array.isArray(x))add(path,'invalid_type');else{if(x.length>rule.maxItems)add(path,'too_many');if(x.some(v=>typeof v!=='string'))add(path,'invalid_type');else if(x.some(v=>v.length>rule.maxLength))add(path,'too_long');else if(x.some(v=>!/^https:\/\//.test(v)&&v!=='model_knowledge'))add(path,'invalid_ref');}}
  else if(rule.kind==='number'){if(x===undefined)add(path,'required');else if(typeof x!=='number'||!Number.isFinite(x))add(path,'invalid_type');else if(x<rule.min||x>rule.max)add(path,'out_of_range');else if(rule.step&&(x/rule.step)%1!==0)add(path,'invalid_step');}
  else if(rule.kind==='text'){if(x===undefined||x===null){if(!rule.nullable)add(path,'required');}else if(typeof x!=='string')add(path,'invalid_type');else if(!x.trim().length)add(path,'empty');else if(x.length>rule.maxLength)add(path,'too_long');}
 }
 return issues;
}
function fingerprintIssues(f){const issues=ruleIssues('fingerprint',FINGERPRINT_RULES,f);if(isObject(f)&&!issues.length&&JSON.stringify(f).length>FINGERPRINT_MAX_CHARS)issues.push({path:'fingerprint',code:'too_large'});return issues;}
function predictionIssues(p){return ruleIssues('prediction',PREDICTION_RULES,p);}
const issueText=issues=>issues.length?'Invalid '+issues.map(issue=>issue.path+' '+issue.code).join(', '):null;
function validateFingerprint(f){return issueText(fingerprintIssues(f));}
function validatePrediction(p){return issueText(predictionIssues(p));}
function schemaContract(){return {version:1,fingerprint:{rules:FINGERPRINT_RULES,maxChars:FINGERPRINT_MAX_CHARS},prediction:{rules:PREDICTION_RULES},issueCodes:ISSUE_CODES,issuePath:'<fingerprint|prediction>[.<field>[.<execution dimension>]]; a list issue names the list, not the item',reportedVia:'POST /api/enrichment/submit results[].validation {stage, reportedBy, issues[]}'};}
const fingerprintCurrent=f=>!!f&&f.fingerprintSchemaVersion===FINGERPRINT_SCHEMA_VERSION&&!f.invalidatedAt;
function executionFacet(execution){const out={};if(!execution||typeof execution!=='object')return out;for(const key of GENERAL_EXECUTION){const value=execution[key];if(typeof value==='string'&&EXECUTION[key].includes(value)&&value!=='unknown'&&value!=='not_applicable')out[key]=value;}return out;}
// The display facet of a usable fingerprint: exact today; exact or compatible when the caller judged it under the transition rule.
const fingerprintFacet=(f,usable=fingerprintCurrent(f))=>usable&&f?{plotMechanics:f.plotMechanics||[],moodLabels:f.moodLabels||[],execution:executionFacet(f.execution),fingerprintHash:f.fingerprintHash}:null;
// Selective compatibility (ADR-0031) needs what the display facet drops: the raw execution values (unknown, not_applicable,
// genre-specific dimensions) and the schema of the exact fingerprint. Copied from the full fingerprint, bound to its hash.
const fingerprintImpactFacet=f=>f&&typeof f.fingerprintHash==='string'&&f.fingerprintHash?{fingerprintHash:f.fingerprintHash,fingerprintSchemaVersion:f.fingerprintSchemaVersion??null,fingerprintPromptVersion:f.fingerprintPromptVersion??null,invalidatedAt:f.invalidatedAt||null,plotMechanics:Array.isArray(f.plotMechanics)?[...f.plotMechanics]:null,execution:isObject(f.execution)?{...f.execution}:null}:null;
const predictionCurrent=(p,profile,f)=>!!p&&!!profile&&fingerprintCurrent(f)&&p.tasteProfileVersion===profile.version&&p.tasteProfileHash===profile.profileHash&&p.fingerprintHash===f.fingerprintHash&&p.fingerprintSchemaVersion===FINGERPRINT_SCHEMA_VERSION&&p.predictionPromptVersion===PREDICTION_PROMPT_VERSION;
async function readFilmState(env,id){const key=filmKey(id);const [fingerprint,predictions]=await Promise.all([loadJSON(env,key+'fingerprint.json'),loadJSON(env,key+'predictions.json')]);return {fingerprint,predictions};}
function cloneJSON(value){return JSON.parse(JSON.stringify(value));}
function ratingObservationIdentity(item){return JSON.stringify([item.filmId,item.before??null,item.after??null,item.source||null,item.generationId||null,item.programmeRunId||null,item.sourceUrl||null]);}
async function mergeStoredJSON(env,key,empty,apply){
 for(let attempt=0;attempt<5;attempt++){
  const object=await env.BUCKET.get(key),current=object?await object.json():cloneJSON(empty),next=await apply(cloneJSON(current));
  if(next==null)return current;
  const saved=await env.BUCKET.put(key,JSON.stringify(next),{httpMetadata:{contentType:'application/json'},onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});
  if(saved!==null)return next;
 }
 throw new Error('Stored JSON changed during write');
}
async function appendRatingObservations(env,incoming){
 if(!incoming?.length)return;
 await mergeStoredJSON(env,ratingObservationsKey,[],current=>{let changed=false;for(const item of incoming)if(!current.some(existing=>ratingObservationIdentity(existing)===ratingObservationIdentity(item))){current.push(item);changed=true;}return changed?current:null;});
}
async function updateViewIndex(env,id,changes){
 const key=ENRICHMENT_KEY+'view-index.json';
 for(let attempt=0;attempt<5;attempt++){
  const object=await env.BUCKET.get(key),current=object?await object.json():{};
  const next=cloneJSON(current);next[id]={...(next[id]||{}),...changes};next[id].moodFacet=canonicalMoodFacet(next[id].fingerprint,next[id].prediction);
  await saveJSON(env,filmKey(id)+'mood-facet.json',next[id].moodFacet);
  const saved=await env.BUCKET.put(key,JSON.stringify(next),{httpMetadata:{contentType:'application/json'},onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});
  if(saved!==null)return next;
 }
 throw new Error('Stored JSON changed during write');
}
async function ensureInitialRatings(env){
 return mergeStoredJSON(env,ENRICHMENT_KEY+'view-index.json',{},index=>applyRatingsSeed(index)?index:null);
}
function parsePersonalRating(html,filmUrl,username){
 for(const script of html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)){
  let value;try{value=JSON.parse(script[1].replace(/\/\*[\s\S]*?\*\//g,''));}catch{continue;}
  const author=Array.isArray(value.author)?value.author:[value.author];
  if(value['@type']!=='Review'||!author.some(a=>a?.sameAs===`https://letterboxd.com/${username}/`)||value.itemReviewed?.sameAs!==filmUrl)continue;
  const rating=Number(value.reviewRating?.ratingValue);if(Number.isFinite(rating)&&rating>=.5&&rating<=5&&rating*2%1===0)return rating;
 }
 return null;
}
async function refreshPersonalRating(env,film){
 const id=String(film.id),match=String(film.url||'').match(/^https:\/\/letterboxd\.com\/film\/([a-z0-9-]+)\/$/);if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id)||!match)throw new Error('Invalid Letterboxd film identity');
 const username=sourceConfig(env).letterboxdUsername,sourceUrl=`https://letterboxd.com/${username}/film/${match[1]}/`,requestedAt=new Date().toISOString();let response;
 try{response=await fetch(sourceUrl,{headers:{'User-Agent':'Mozilla/5.0 (compatible; WatchlistAirtime/1.0)','Accept':'text/html'},signal:AbortSignal.timeout(15000)});}catch(e){throw new Error('Rating lookup failed: '+e.message);}
 if(response.status===404)return {filmId:id,status:'not_found'};if(!response.ok)throw new Error('Rating source HTTP '+response.status);
 const rating=parsePersonalRating(await response.text(),film.url,username);if(rating===null)return {filmId:id,status:'not_rated'};
 if(env.LETTERBOXD_FACTS==='on'){const facts=await LetterboxdFacts.recordFilmFacts(env,id,{watched:true,rating},{observedAt:requestedAt,source:'letterboxd_film_page',sourceRef:sourceUrl});if(facts.conflict)return {filmId:id,status:'identity_conflict'};const saved=facts.outcomes.some(o=>o.outcome==='new'||o.outcome==='replaces');if(saved&&facts.record.rating?.value===rating)await saveJSON(env,filmKey(id)+'actual.json',{rating,source:'letterboxd',sourceUrl,updatedAt:requestedAt});await enrichRecentRemovalRatings(env,{[id]:rating},requestedAt);return {filmId:id,status:saved?'saved':'unchanged',rating};}
 const [previous,index]=await Promise.all([loadJSON(env,filmKey(id)+'actual.json'),ensureInitialRatings(env)]),before=index[id]?.actualRating??null;
 if(previous?.rating===rating&&before===rating){await enrichRecentRemovalRatings(env,{[id]:rating},previous.updatedAt||null);return {filmId:id,status:'unchanged',rating};}
 const observedAt=new Date().toISOString();
 if(before!==rating)await recordRatingObservation(env,{filmId:id,before,after:rating,observedAt,source:'letterboxd_member_film',sourceUrl});
 if(previous?.rating!==rating)await saveJSON(env,filmKey(id)+'actual.json',{rating,source:'letterboxd',sourceUrl,updatedAt:observedAt});
 await updateViewIndex(env,id,{actualRating:rating});await enrichRecentRemovalRatings(env,{[id]:rating},observedAt);return {filmId:id,status:'saved',rating};
}
// AIR-268: films removed from the watchlist are looked up one by one on their own member page, so a removal event gets
// its rating without the 31-page films list. Gated by REMOVAL_RATING_LOOKUP (off by default). The queue is bounded,
// each attempt is recorded before its request (a killed request cannot loop), a 403 or 429 stops the batch, and a
// film is retried on later EPG commits at most REMOVAL_LOOKUP_MAX_ATTEMPTS times. No rating found never means watched.
const REMOVAL_LOOKUP_KEY=ENRICHMENT_KEY+'removal-rating-lookups.json';
const REMOVAL_LOOKUP_BATCH=5,REMOVAL_LOOKUP_MAX_ATTEMPTS=3,REMOVAL_LOOKUP_CAP=100,REMOVAL_LOOKUP_KEEP_MS=14*86400000;
const REMOVAL_LOOKUP_RETRY_MS={claimed:3600000,failed:3600000,blocked:6*3600000,rate_limited:6*3600000,not_rated:24*3600000};
const removalLookupEnabled=env=>env?.REMOVAL_RATING_LOOKUP==='on';
const removalLookupFilm=film=>{const id=String(film?.id??''),url=String(film?.url||'');return /^[a-zA-Z0-9_-]{1,80}$/.test(id)&&/^https:\/\/letterboxd\.com\/film\/[a-z0-9-]+\/$/.test(url)?{id,url}:null;};
// A film still pending is never dropped: past 14 days it becomes `expired` (visible, no more requests); the cap and the
// 14-day retention apply to finished entries only.
function pruneRemovalLookups(queue,now){
 let changed=false;const old=entry=>!(now-Date.parse(entry.enqueuedAt)<=REMOVAL_LOOKUP_KEEP_MS);
 for(const [id,entry] of Object.entries(queue.films)){
  if(entry.state==='pending'){if(old(entry)){queue.films[id]={...entry,state:'expired',nextAttemptAt:null};changed=true;}continue;}
  if(entry.state!=='expired'&&old(entry)||entry.state==='expired'&&now-Date.parse(entry.enqueuedAt)>2*REMOVAL_LOOKUP_KEEP_MS){delete queue.films[id];changed=true;}
 }
 const finished=Object.keys(queue.films).filter(id=>queue.films[id].state!=='pending');
 if(finished.length>REMOVAL_LOOKUP_CAP){for(const id of finished.sort((a,b)=>Date.parse(queue.films[a].enqueuedAt)-Date.parse(queue.films[b].enqueuedAt)).slice(0,finished.length-REMOVAL_LOOKUP_CAP))delete queue.films[id];changed=true;}
 return changed;
}
function removalLookupOutcome(entry,result,error,at){
 const later=kind=>new Date(Date.parse(at)+REMOVAL_LOOKUP_RETRY_MS[kind]).toISOString(),last=entry.attempts>=REMOVAL_LOOKUP_MAX_ATTEMPTS;
 if(error){const code=/HTTP 403\b/.test(error)?'blocked':/HTTP 429\b/.test(error)?'rate_limited':'failed';return {...entry,state:last?'gave_up':'pending',lastResult:code,lastError:String(error).slice(0,120),nextAttemptAt:last?null:later(code)};}
 if(result.status==='saved'||result.status==='unchanged')return {...entry,state:'rated',rating:result.rating,lastResult:result.status,checkedAt:at,nextAttemptAt:null,lastError:null};
 if(result.status==='not_rated')return {...entry,state:last?'not_rated':'pending',lastResult:'not_rated',checkedAt:at,nextAttemptAt:last?null:later('not_rated'),lastError:null};
 return {...entry,state:result.status==='identity_conflict'?'conflict':'not_found',lastResult:result.status,checkedAt:at,nextAttemptAt:null,lastError:null};
}
async function lookupRemovalRatings(env,incoming=[],now=Date.now()){
 if(!removalLookupEnabled(env))return null;
 const at=new Date(now).toISOString(),summary={checked:0,rated:0,notRated:0,failed:0,stoppedBy:null,pending:0,expired:0,queued:0};
 try{
  const films=(Array.isArray(incoming)?incoming:[]).map(removalLookupFilm).filter(Boolean);
  let queue=await mergeStoredJSON(env,REMOVAL_LOOKUP_KEY,{schemaVersion:1,films:{}},q=>{
   let changed=false;
   for(const {id,url} of films)if(!q.films[id]){q.films[id]={url,state:'pending',attempts:0,enqueuedAt:at,nextAttemptAt:at,lastAttemptAt:null,lastResult:null};changed=true;}
   return pruneRemovalLookups(q,now)||changed?q:null;
  });
  // A 403 or 429 is about the source, not the film: the whole queue waits until the backoff ends.
  if(queue.pausedUntil&&Date.parse(queue.pausedUntil)>now){summary.stoppedBy=queue.pausedBy||'blocked';summary.pausedUntil=queue.pausedUntil;}
  const due=summary.stoppedBy?[]:Object.entries(queue.films).filter(([,entry])=>entry.state==='pending'&&entry.attempts<REMOVAL_LOOKUP_MAX_ATTEMPTS&&Date.parse(entry.nextAttemptAt)<=now)
   .sort(([,a],[,b])=>Date.parse(a.enqueuedAt)-Date.parse(b.enqueuedAt)).slice(0,REMOVAL_LOOKUP_BATCH).map(([id])=>id);
  for(const id of due){
   // Claim first: a request killed mid-lookup leaves a counted attempt and a later retry time, never a free retry.
   queue=await mergeStoredJSON(env,REMOVAL_LOOKUP_KEY,{schemaVersion:1,films:{}},q=>{const entry=q.films[id];if(!entry||entry.state!=='pending'||Date.parse(entry.nextAttemptAt)>now)return null;q.films[id]={...entry,attempts:entry.attempts+1,lastAttemptAt:at,nextAttemptAt:new Date(now+REMOVAL_LOOKUP_RETRY_MS.claimed).toISOString(),lastResult:'claimed'};return q;});
   const claimed=queue.films[id];if(claimed?.lastAttemptAt!==at||claimed.lastResult!=='claimed')continue;
   let result=null,error=null;try{result=await refreshPersonalRating(env,{id,url:claimed.url});}catch(e){error=String(e.message);}
   queue=await mergeStoredJSON(env,REMOVAL_LOOKUP_KEY,{schemaVersion:1,films:{}},q=>{const entry=q.films[id];if(!entry)return null;const next=removalLookupOutcome(entry,result,error,at);q.films[id]=next;if(next.lastResult==='blocked'||next.lastResult==='rate_limited'){q.pausedUntil=new Date(now+REMOVAL_LOOKUP_RETRY_MS[next.lastResult]).toISOString();q.pausedBy=next.lastResult;}return q;});
   const entry=queue.films[id];summary.checked++;
   if(entry?.state==='rated')summary.rated++;else if(entry?.lastResult==='not_rated')summary.notRated++;else if(error)summary.failed++;
   if(entry?.lastResult==='blocked'||entry?.lastResult==='rate_limited'){summary.stoppedBy=entry.lastResult;summary.pausedUntil=queue.pausedUntil;break;}
  }
  summary.queued=Object.keys(queue.films).length;summary.pending=Object.values(queue.films).filter(entry=>entry.state==='pending').length;summary.expired=Object.values(queue.films).filter(entry=>entry.state==='expired').length;
  return {...summary,at};
 }catch(e){return {...summary,at,error:String(e.message).slice(0,160)};}
}
async function recordRatingObservation(env,observation){if(!await loadJSON(env,diagnosticSnapshotKey))return;await appendRatingObservations(env,[observation]);}
function parsePublicFilmsPage(html,username){
 const count=html.match(/title="([\d,]+)&nbsp;films"/i),total=count?Number(count[1].replaceAll(',','')):null;
 const entries=[];
 for(const item of html.matchAll(/<li\b[^>]*class="[^"]*\bgriditem\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)){
  const id=item[1].match(/data-postered-identifier='[^']*?&quot;lid&quot;:&quot;([a-zA-Z0-9_-]+)&quot;/),stars=item[1].match(/\brated-(10|[1-9])\b/);
  if(id)entries.push({id:id[1],rating:stars?Number(stars[1])/2:null});
 }
 const next=html.match(new RegExp('<a\\b[^>]*class="next"[^>]*href="(/'+username+'/films/page/\\d+/)"','i'))?.[1]||null;
 if(!Number.isInteger(total)||!entries.length)throw new Error('Incomplete Letterboxd films page');
 return {total,entries,next};
}
async function refreshRatingsFromFilms(env,report,extraIds=[]){
 const username=sourceConfig(env).letterboxdUsername,scanStartedAt=new Date().toISOString();let url=`https://letterboxd.com/${username}/films/`,total=null,pages=0;const seen=new Map();
 while(url){
  let response;for(let attempt=0;attempt<3;attempt++){response=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (compatible; WatchlistAirtime/1.0)','Accept':'text/html','Accept-Language':'en-US,en;q=0.9'},signal:AbortSignal.timeout(15000)});if(response.status!==403||attempt===2)break;await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));}
  if(!response.ok){const body=await response.text(),challenge=/cloudflare|just a moment|attention required|captcha|bot detection/i.test(body);throw new Error('Letterboxd films HTTP '+response.status+' on page '+(pages+1)+(challenge?' (anti-bot challenge)':''));}
  const page=parsePublicFilmsPage(await response.text(),username);pages++;
  if(pages>60||total!==null&&page.total!==total)throw new Error('Letterboxd films pagination changed');
  total=page.total;
  for(const item of page.entries){if(seen.has(item.id))throw new Error('Duplicate Letterboxd film');seen.set(item.id,item.rating);}
  url=page.next?'https://letterboxd.com'+page.next:null;
 }
 if(seen.size!==total)throw new Error('Incomplete Letterboxd films: '+seen.size+'/'+total);
 const baseline=await loadJSON(env,diagnosticSnapshotKey);
 const watchlistIds=new Set((report.films||[]).map(f=>String(f.id))),extra=new Set((extraIds||[]).map(id=>String(id)).filter(id=>/^[a-zA-Z0-9_-]{1,80}$/.test(id))),ids=[...new Set([...watchlistIds,...(baseline?.films||[]).map(f=>String(f.filmId)),...extra])];
 let rated=0;const assignments=[];
 for(const id of ids){const rating=seen.get(id)??null,inWatchlist=watchlistIds.has(id);if(rating!==null&&inWatchlist)rated++;if(!inWatchlist&&rating===null)continue;assignments.push({id,rating});}
 const observedAt=new Date().toISOString(),removedRatings={};
 for(const id of extra){if(!seen.has(id))continue;const rating=confirmedHalfStar(seen.get(id));if(rating!=null)removedRatings[id]=rating;}
 // With LETTERBOXD_FACTS the scan is one summary observation (ADR-0024): absence no longer clears a rating.
 if(env.LETTERBOXD_FACTS==='on'){const facts=await LetterboxdFacts.applyFilmsListScan(env,{scanId:'films-list-'+(report.runId||crypto.randomUUID()),observedAt:scanStartedAt,films:Object.fromEntries(seen),total},{watchlistFilms:report.films||[]});return {pages,watched:total,watchlistRated:rated,changed:facts.written,removedRatings,observedAt,facts:{written:facts.written,carried:facts.carried,conflicts:facts.conflicts,outcomes:facts.outcomes}};}
 const observations=[];let changed=0;
 await mergeStoredJSON(env,ENRICHMENT_KEY+'view-index.json',{},index=>{
  observations.length=0;const seeded=applyRatingsSeed(index);changed=0;
  for(const {id,rating} of assignments){if(index[id]?.actualRating===rating)continue;const before=index[id]?.actualRating??null;if(baseline)observations.push({filmId:id,before,after:rating,observedAt:new Date().toISOString(),source:'letterboxd_public_films',programmeRunId:report.runId});index[id]={...(index[id]||{}),actualRating:rating};changed++;}
  return seeded||changed?index:null;
 });
 if(observations.length)await appendRatingObservations(env,observations);
 return {pages,watched:total,watchlistRated:rated,changed,removedRatings,observedAt};
}
async function repairRemovedBaselineRatings(env,report){
 const baseline=await loadJSON(env,diagnosticSnapshotKey);if(!baseline)return {attempted:0,saved:0,errors:[]};
 const current=new Set((report.films||[]).map(f=>String(f.id))),index=await ensureInitialRatings(env);
 const candidates=baseline.films.filter(f=>!current.has(f.filmId)&&f.actualAtFreeze===null&&index[f.filmId]?.actualRating==null&&/^https:\/\/letterboxd\.com\/film\/[a-z0-9-]+\/$/.test(f.letterboxdUri)).slice(0,10);
 const results=[];for(const f of candidates){try{results.push(await refreshPersonalRating(env,{id:f.filmId,url:f.letterboxdUri}));}catch(e){results.push({filmId:f.filmId,error:String(e.message).slice(0,160)});}}
 return {attempted:results.length,saved:results.filter(r=>r.status==='saved').length,errors:results.filter(r=>r.error)};
}
function parsePublicDiaryPage(html){
 const entries=[];
 for(const row of html.matchAll(/<tr\b[^>]*class="[^"]*\bdiary-entry-row\b[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi)){
  const id=row[1].match(/data-postered-identifier="[^"]*?&quot;lid&quot;:&quot;([a-zA-Z0-9_-]+)&quot;/),stars=row[1].match(/\brated-(10|[1-9])\b/);
  if(id&&stars)entries.push({id:id[1],rating:Number(stars[1])/2});
 }
 if(!entries.length)throw new Error('Incomplete Letterboxd diary page');
 return entries;
}
async function repairRecentDiaryRatings(env,report){
 const username=sourceConfig(env).letterboxdUsername,response=await fetch(`https://letterboxd.com/${username}/diary/`,{headers:{'User-Agent':'Mozilla/5.0 (compatible; WatchlistAirtime/1.0)','Accept':'text/html','Accept-Language':'en-US,en;q=0.9'},signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw new Error('Letterboxd diary HTTP '+response.status);
 const entries=parsePublicDiaryPage(await response.text()),baseline=await loadJSON(env,diagnosticSnapshotKey),index=await ensureInitialRatings(env);
 const films=new Map([...(report.films||[]).map(f=>[String(f.id),{id:String(f.id),url:f.url}]),...(baseline?.films||[]).map(f=>[f.filmId,{id:f.filmId,url:f.letterboxdUri}])]);
 const changed=new Map(entries.filter(e=>films.has(e.id)&&index[e.id]?.actualRating!==e.rating).map(e=>[e.id,e]));
 const results=[];for(const id of changed.keys()){try{results.push(await refreshPersonalRating(env,films.get(id)));}catch(e){results.push({filmId:id,error:String(e.message).slice(0,160)});}}
 return {diaryEntries:entries.length,attempted:results.length,saved:results.filter(r=>r.status==='saved').length,errors:results.filter(r=>r.error)};
}
async function freezeDiagnosticSnapshot(env){
 const existing=await loadJSON(env,diagnosticSnapshotKey);if(existing)return {snapshot:existing,created:false};
 const [programme,index,profile]=await Promise.all([loadJSON(env,'programme.json'),ensureInitialRatings(env),loadJSON(env,profileKey)]);
 if(!programme?.films?.length)return {error:'No programme snapshot'};
 const unique=eligibleEnrichmentFilms(programme),states=await Promise.all(unique.map(f=>readFilmState(env,f.id)));
 const actuals=await Promise.all(unique.map(f=>loadJSON(env,filmKey(f.id)+'actual.json')));
 const snapshot={schemaVersion:1,frozenAt:new Date().toISOString(),programmeRunId:programme.runId,programmeUpdatedAt:programme.updatedAt,profileVersion:profile?.version??null,profileHash:profile?.profileHash??null,films:unique.map((film,i)=>({filmId:String(film.id),title:film.title,original:film.original,year:film.year,genres:film.genres||[],runtime:film.runtime??null,letterboxdUri:film.url,actualAtFreeze:index[String(film.id)]?.actualRating??null,actualRecord:actuals[i]||null,prediction:states[i].predictions?.current||null,fingerprint:states[i].fingerprint||null}))};
 await saveJSON(env,diagnosticSnapshotKey,snapshot);return {snapshot,created:true};
}
function accuracyMetrics(candidates){
 const n=candidates.length,mean=key=>n?candidates.reduce((sum,x)=>sum+x[key],0)/n:null;
 const calibration=n>=30?{brier:candidates.reduce((sum,x)=>sum+(x.probability4Plus-Number(x.actual4Plus))**2,0)/n,bins:[0,.2,.4,.6,.8].map((lower,i)=>{const upper=lower+.2,items=candidates.filter(x=>x.probability4Plus>=lower&&(i===4?x.probability4Plus<=1:x.probability4Plus<upper));return {from:lower,to:upper,count:items.length,meanPrediction:items.length?items.reduce((sum,x)=>sum+x.probability4Plus,0)/items.length:null,observed4Plus:items.length?items.filter(x=>x.actual4Plus).length/items.length:null};})}:null;
 const tp=candidates.filter(x=>x.predicted4Plus&&x.actual4Plus).length,fp=candidates.filter(x=>x.predicted4Plus&&!x.actual4Plus).length,tn=candidates.filter(x=>!x.predicted4Plus&&!x.actual4Plus).length,fn=candidates.filter(x=>!x.predicted4Plus&&x.actual4Plus).length;
 return {n,exactHits:candidates.filter(x=>x.exactHit).length,exactHitRate:n?candidates.filter(x=>x.exactHit).length/n:null,MAE:mean('absoluteError'),bias:mean('signedError'),classification4Plus:{threshold:.5,tp,fp,tn,fn,correct:tp+tn,accuracy:n?(tp+tn)/n:null,precision:tp+fp?tp/(tp+fp):null,recall:tp+fn?tp/(tp+fn):null},calibration};
}
function prospectiveAccuracy(snapshot,observations){
 const candidates=[],historicalPreSnapshot=[],excluded=[];
 for(const film of snapshot.films){
  const prediction=film.prediction;if(!prediction?.generatedAt)continue;
  const events=(observations||[]).filter(o=>o.filmId===film.filmId&&o.before===null&&Number.isFinite(o.after)&&Date.parse(o.observedAt)>Date.parse(prediction.generatedAt)).sort((a,b)=>a.observedAt.localeCompare(b.observedAt));
  if(film.actualAtFreeze!==null){excluded.push({filmId:film.filmId,title:film.title,reason:'rated_at_freeze',actualRating:film.actualAtFreeze,actualRecordAt:film.actualRecord?.updatedAt??null});continue;}
  if(events.length){const o=events[0],error=o.after-prediction.predictedRating,predicted4Plus=prediction.probability4Plus>=.5,actual4Plus=o.after>=4;
   const historical=Date.parse(prediction.generatedAt)<Date.parse(snapshot.frozenAt)&&o.predictionImmutableSinceGeneratedAt!==true;
   const row={filmId:film.filmId,title:film.title,year:film.year,predictedRating:prediction.predictedRating,probability4Plus:prediction.probability4Plus,generatedAt:prediction.generatedAt,snapshotFrozenAt:snapshot.frozenAt,actualRating:o.after,firstSeenActualAt:o.observedAt,observedAt:o.observedAt,error,absoluteError:Math.abs(error),signedError:error,exactHit:error===0,predicted4Plus,actual4Plus,classification4Plus:predicted4Plus?(actual4Plus?'true_positive':'false_positive'):(actual4Plus?'false_negative':'true_negative'),eligibility:historical?'historical_pre_snapshot':'prospective',source:o.source||null};
   (historical?historicalPreSnapshot:candidates).push(row);}
 }
 return {snapshotFrozenAt:snapshot.frozenAt,observations:candidates,historicalPreSnapshot,excludedRatedAtFreeze:excluded.length,metrics:accuracyMetrics(candidates),historicalMetrics:accuracyMetrics(historicalPreSnapshot)};
}
async function ratingsBackfill(env,body){
 if(!Number.isInteger(body.cursor)||body.cursor<0||!Number.isInteger(body.batchSize)||body.batchSize<1||body.batchSize>10)return json({error:'Invalid cursor or batchSize'},400);
 const report=await loadJSON(env,'programme.json');if(!report?.runId||!Array.isArray(report.films))return json({error:'No published programme'},409);if(body.programmeRunId&&body.programmeRunId!==report.runId)return json({error:'Programme changed; restart backfill'},409);
 const films=[...new Map(report.films.map(f=>[String(f.id),f])).values()].sort((a,b)=>String(a.id).localeCompare(String(b.id),'en'));const selected=films.slice(body.cursor,body.cursor+body.batchSize),results=[];
 for(const film of selected){try{results.push(await refreshPersonalRating(env,film));}catch(e){results.push({filmId:String(film.id),error:String(e.message).slice(0,200)});}}
 return json({programmeRunId:report.runId,total:films.length,cursor:body.cursor,nextCursor:body.cursor+selected.length,done:body.cursor+selected.length>=films.length,results});
}
function eligibleEnrichmentFilms(report){const ids=new Set();return (report.films||[]).filter(f=>{const id=String(f.id);if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id)||ids.has(id))return false;ids.add(id);return true;}).sort((a,b)=>String(a.id).localeCompare(String(b.id),'en'));}
function allEnrichmentFilms(report,catalog){const watchlist=eligibleEnrichmentFilms(report),seen=new Set(),films=[];for(const film of [...watchlist,...Object.values(catalog||{}).sort((a,b)=>String(a.id).localeCompare(String(b.id),'en'))]){const identity=film.tmdbId?'tmdb:'+String(film.tmdbId):'legacy:'+String(film.id);if(seen.has(identity))continue;seen.add(identity);films.push(film);}return films.sort((a,b)=>String(a.id).localeCompare(String(b.id),'en'));}
function modelMetadata(film){return {id:String(film.id),letterboxdUri:film.url?.startsWith('https://letterboxd.com/')?film.url:null,tmdbUri:film.tmdbId?'https://www.themoviedb.org/movie/'+film.tmdbId:null,title:film.title,original:film.original,year:film.year,genres:film.genres,synopsis:film.synopsis,directors:film.directors,actors:film.actors,runtime:film.runtime||null};}
// Two different times, never interchangeable (see docs/reference/scheduled-tasks.md):
// - nextCatchUpAt() is the Worker's own earliest-retry gate for discovery `wait`: the next whole UTC hour. It throttles
//   a new chunk series to one per clock hour and does not depend on any external schedule, so the discovery wait and
//   fencing rules behave the same whether or not the schedule below is known. It is not a scheduled run.
// - hourlyTaskRunAt() is the nominal trigger of the external hourly ChatGPT Scheduled Task. The live recurrence lives in
//   the task registry, which the Worker cannot read; HOURLY_TASK_SCHEDULE is the single statement of the expected one.
//   It is an estimate (the scheduler can run late), never a gate, and it is null when the schedule is not usable.
const nextCatchUpAt=()=>new Date(Math.floor(Date.now()/3600000+1)*3600000).toISOString();
const HOURLY_TASK_SCHEDULE=Object.freeze({timeZone:'Europe/Madrid',minute:20});
// The first instant at or after `from` whose wall-clock minute in the schedule's time zone is the scheduled minute.
// The minute is read through Intl per candidate, so DST changes and zones with non-hour offsets are handled; on a
// DST change in a whole-hour zone the hourly instants stay one UTC hour apart.
function hourlyTaskRunAt(from=Date.now(),schedule=HOURLY_TASK_SCHEDULE){
 if(!Number.isFinite(from)||!schedule||typeof schedule.timeZone!=='string'||!Number.isInteger(schedule.minute)||schedule.minute<0||schedule.minute>59)return null;
 let format;try{format=new Intl.DateTimeFormat('en-GB',{timeZone:schedule.timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});}catch{return null;}
 const minuteAt=ms=>Number(format.formatToParts(ms).find(part=>part.type==='minute')?.value);
 for(let hour=Math.floor(from/3600000)*3600000;hour<=from+3*3600000;hour+=3600000){
  const local=minuteAt(hour);if(!Number.isInteger(local))return null;
  const candidate=hour+((schedule.minute-local+60)%60)*60000;
  if(candidate>=from&&minuteAt(candidate)===schedule.minute)return new Date(candidate).toISOString();
 }
 return null;
}
// Prediction responses: `nextCatchUpAt` is the compatibility name of the same nominal hourly run, not a gate.
const scheduledRunFields=()=>{const at=hourlyTaskRunAt();return {nextCatchUpAt:at,nextScheduledRunAt:at};};
// The profile rule (ADR-0031) is always selective: the shared evaluator keeps a prediction that no published, owner-approved
// change impact reaches, and an unknown or unapproved change fails closed (stale). No variable selects it: the former
// PREDICTION_PROFILE_COMPATIBILITY switch is retired (ADR 0044) and a stale binding is inert. The strict outcome is still
// counted beside it in the queue's diagnostic block.
const PREDICTION_PROFILE_MODE='selective';
// SHA-256 of every lineage link's declaration, computed once, so the pure evaluator can re-check each approval.
async function profileLineageDigests(profile){
 const digests=new Map();
 for(const link of Array.isArray(profile?.lineage)?profile.lineage:[]){const text=profileDeclarationText(link?.changeImpact,{version:link?.version,profileHash:link?.profileHash});if(text&&!digests.has(text))digests.set(text,await profileDeclarationHash(text));}
 return text=>digests.get(text)??null;
}
// One film's compatibility from the view index: the fingerprint and features come from the impact facet copied from the
// full fingerprint, never from the display facet. Without it the features are unknown, so a selective link is stale.
function indexedPredictionCompatibility(item,film,profile,mode,digest){
 const impact=item?.impactFeatures,bound=!!impact&&impact.fingerprintHash===item?.fingerprintHash;
 const fingerprint=item?.fingerprintHash?{fingerprintHash:item.fingerprintHash,fingerprintSchemaVersion:bound?impact.fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,invalidatedAt:bound?impact.invalidatedAt:null}:null;
 const features=bound?predictionImpactFeatures({fingerprintHash:impact.fingerprintHash,plotMechanics:impact.plotMechanics??undefined,execution:impact.execution??undefined},film?.genres):null;
 return predictionCompatibility(item?.prediction,fingerprint,features,profile,mode,{vocabulary:{mechanics:MECHANICS,execution:EXECUTION,general:GENERAL_EXECUTION},digest,fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,predictionPromptVersion:PREDICTION_PROMPT_VERSION});
}
// One freshness rule per request (ADR-0031 section 5): every consumer judges a stored prediction with the same profile
// snapshot. The profile rule is the shared evaluator, with features from the full fingerprint (state) or from the index's
// impact facet (indexed), and the film's stored genres.
// The fingerprint transition evaluator's inputs (ADR-0035): the code's target versions, the registry and the digests of its
// declarations. The registry is a code constant, so its digests are computed once per isolate.
const fingerprintTarget=()=>({fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,fingerprintPromptVersion:FINGERPRINT_PROMPT_VERSION,predictionPromptVersion:PREDICTION_PROMPT_VERSION});
let fingerprintRegistryDigestsPromise=null;
function fingerprintRegistryDigests(){
 return fingerprintRegistryDigestsPromise||=(async()=>{
  const digests=new Map();
  for(const transition of FINGERPRINT_TRANSITIONS){try{const text=fingerprintTransitionDeclarationText(transition);if(!digests.has(text))digests.set(text,await profileDeclarationHash(text));}catch{}}
  const registry=await profileDeclarationHash(JSON.stringify(canonical(FINGERPRINT_TRANSITIONS)));
  return {lookup:text=>digests.get(text)??null,registry};
 })();
}
const fingerprintEvaluatorOptions=digest=>({vocabulary:FINGERPRINT_SCHEMA_BASE,digest});
// The fingerprint record the evaluator judges, from the view index's impact facet. Without a facet bound to the entry's hash
// the record is unknown to the evaluator and fails closed.
function indexedFingerprintRecord(item){
 const impact=item?.impactFeatures;
 if(!item?.fingerprintHash||!impact||impact.fingerprintHash!==item.fingerprintHash)return null;
 return {fingerprintHash:impact.fingerprintHash,fingerprintSchemaVersion:impact.fingerprintSchemaVersion,fingerprintPromptVersion:impact.fingerprintPromptVersion??1,invalidatedAt:impact.invalidatedAt||null,plotMechanics:impact.plotMechanics??undefined,execution:impact.execution??undefined};
}
async function predictionFreshness(env,profile){
 const mode=PREDICTION_PROFILE_MODE,fingerprintMode=PREDICTION_FINGERPRINT_MODE,digest=profile?await profileLineageDigests(profile):null;
 // The combined verdict checks two kinds of approval: the registry's declarations and the profile lineage's; one digest lookup serves both.
 const registry=await fingerprintRegistryDigests(),transitionOptions=fingerprintEvaluatorOptions(text=>registry.lookup(text)??digest?.(text)??null),modes={fingerprint:fingerprintMode,prompt:fingerprintMode,profile:mode};
 // One verdict covers the fingerprint, the prediction prompt and the profile, and it decides.
 const verdict=(prediction,fingerprint,genres)=>predictionTransitionCompatibility(prediction,fingerprint,{genres},profile,FINGERPRINT_TRANSITIONS,fingerprintTarget(),modes,transitionOptions);
 const fingerprintVerdict=(fingerprint,genres)=>fingerprintCompatibility(fingerprint,{genres},FINGERPRINT_TRANSITIONS,fingerprintTarget(),fingerprintMode,transitionOptions);
 return {mode,fingerprintMode,needsGenres:true,registryDigest:registry.registry,target:fingerprintTarget(),
  state:(prediction,fingerprint,genres)=>!!profile&&!!prediction&&predictionCompatibilityFresh(verdict(prediction,fingerprint,genres)),
  indexed:(item,film)=>!!profile&&!!item?.prediction&&predictionCompatibilityFresh(verdict(item.prediction,indexedFingerprintRecord(item),film?.genres)),
  // The stored fingerprint may be reused for a prediction when it is exact or compatible under the transition rule.
  fingerprintUsable:(fingerprint,genres)=>fingerprintCompatibilityFresh(fingerprintVerdict(fingerprint,genres)),
  work:(prediction,fingerprint,genres)=>verdict(prediction,fingerprint,genres),
  fingerprintVerdict:(fingerprint,genres)=>fingerprintVerdict(fingerprint,genres)};
}
const strictFreshness=profile=>({mode:'strict',fingerprintMode:'strict',needsGenres:false,registryDigest:null,target:fingerprintTarget(),state:(prediction,fingerprint)=>predictionCurrent(prediction,profile,fingerprint),indexed:item=>!!profile&&indexedPredictionCurrent(item,profile),fingerprintUsable:fingerprint=>fingerprintCurrent(fingerprint),work:()=>null,fingerprintVerdict:()=>null});
function indexedPredictionCurrent(item,profile){const p=item?.prediction;return !!p&&p.tasteProfileVersion===profile.version&&p.tasteProfileHash===profile.profileHash&&p.fingerprintHash===item.fingerprintHash&&p.fingerprintSchemaVersion===FINGERPRINT_SCHEMA_VERSION&&p.predictionPromptVersion===PREDICTION_PROMPT_VERSION;}
const PREDICTION_PIPELINE_VERSION=5;
const MAX_PREDICTION_BATCH=20;
const PREDICTION_MUTATION_LEASE=ENRICHMENT_KEY+'writer-lease.json';
function predictionPriority(film,now=Date.now()){
 const starts=(film.shows||[]).map(s=>s.start).filter(t=>Number.isFinite(t)&&t>=now-72*3600000&&t<now+24*3600000);
 if(!starts.length&&Number.isFinite(film.epgLastAiring)&&filmIsHot(film,now))starts.push(film.epgLastAiring);
 const hot=filmIsHot(film,now),availableNow=starts.some(t=>t<=now),today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid'}).format(now),availableToday=starts.some(t=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid'}).format(t)===today),deadline=starts.length?Math.max(...starts)+72*3600000:null;
 return {hot,availableNow,availableToday,availableUntil:deadline?new Date(deadline).toISOString():null,rank:hot?(availableNow&&deadline-now<=24*3600000?0:1):2,expiresInMs:deadline?deadline-now:Infinity};
}
function adaptivePredictionBatch(queue,capacity={}){
 const hot=queue?.priorityCount||0,cold=queue?.coldRemaining??queue?.pending?.length??0,backlog=hot||cold;
 if(!backlog)return {batchSize:0,reason:'empty',usageKnown:Number.isFinite(capacity.remainingPercent)};
 const known=Number.isFinite(capacity.remainingPercent),remaining=known?Math.max(0,Math.min(100,capacity.remainingPercent)):null;
 if(remaining===0||capacity.quotaAvailable===false)return {batchSize:0,reason:'quota',usageKnown:known};
 let size=backlog<=4?backlog:backlog<=15?8:backlog<100?12:20;
 const usageCap=remaining===null?12:remaining<=10?4:remaining<=25?8:20;
 size=Math.min(size,usageCap);
 // Cold never consumes capacity while any hot prediction remains outstanding, including retry backoff.
 if(!hot)size=Math.min(size,5);
 return {batchSize:size,reason:known?'backlog_and_usage':'backlog_usage_unknown_conservative_cap_12',usageKnown:known,remainingPercent:remaining,};
}
function safePredictionReason(value){
 const text=String(value||'');if(['external_termination','retry_backoff','format_error_storm','model_unavailable','api_error','lease_lost'].includes(text))return text;if(/quota|usage|limit/i.test(text))return 'quota';if(/time|deadline/i.test(text))return 'time_budget';if(/parse|json/i.test(text))return 'parse_error';if(/profile/i.test(text))return 'profile_changed';if(/lease|interrupt/i.test(text))return 'lease_expired';if(/storage|persist|checkpoint/i.test(text))return 'storage_error';if(/supersed|priority/i.test(text))return 'priority_changed';return text?'model_error':null;
}
const RUNNER_LEASE_KEY=ENRICHMENT_KEY+'runner-lease.json';
const RUNNER_LEASE_TTL=15*60000;
async function runnerLease(env,runId,operation='renew'){
 const object=await env.BUCKET.get(RUNNER_LEASE_KEY),old=object?await object.json():null,now=Date.now();
 if(operation==='acquire'&&old?.expiresAt>now)return {status:'already_running',runId:old.runId,expiresAt:old.expiresAt};
 if(operation!=='acquire'&&(!old||old.runId!==runId||old.expiresAt<=now))return {status:'lease_lost',runId:old?.runId||null};
 const value={owner:runId,runId,heartbeatAt:new Date(now).toISOString(),expiresAt:operation==='release'?0:now+RUNNER_LEASE_TTL};
 const saved=await env.BUCKET.put(RUNNER_LEASE_KEY,JSON.stringify(value),{onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});
 if(saved===null){const current=await loadJSON(env,RUNNER_LEASE_KEY);return {status:operation==='acquire'?'already_running':'lease_lost',runId:current?.runId||null};}
 return {status:'owned',...value,...(operation==='acquire'&&old?.runId&&old.expiresAt<=now?{recoveredRunId:old.runId}:{})};
}
async function runnerHeartbeat(env,body){
 const run=await checkedRun(env,body?.runId);if(!run||run.status!=='running')return json({error:'Unknown or completed run'},409);
 const lease=await runnerLease(env,run.runId);if(lease.status!=='owned')return json(lease,409);
 run.lastHeartbeatAt=lease.heartbeatAt;await savePredictionRun(env,run);await runnerProgress(env,run,await loadJSON(env,predictionQueueKey));return json({...runSummary(run),expiresAt:lease.expiresAt});
}
async function runnerProgress(env,run,queue,final=false){
 const summary=runSummary(run),success=summary.added+summary.updated,now=Date.now();
 run.hotRemaining=queue?.priorityCount??0;run.coldRemaining=queue?.coldRemaining??0;
 if(!final&&success-(run.progressSavedCount||0)<50&&now-Date.parse(run.lastProgressAt||run.createdAt)<30*60000)return;
 const at=new Date(now).toISOString(),snapshot=await predictionEventSnapshot(env,queue,run.batchSize),delta=predictionEventDelta(run,summary,snapshot);run.progressSavedCount=success;run.lastProgressAt=at;
 await writeEvent(env,{id:'enrichment-'+run.runId+(final?'':'-progress-'+success),type:'enrichment',at,stage:final?run.status:'running',runId:run.runId,trigger:run.trigger,added:summary.added,updated:summary.updated,failed:summary.failed,batchCount:summary.batchCount,batchesProcessed:predictionBatchesProcessed(run),remaining:run.hotRemaining+run.coldRemaining,hotRemaining:run.hotRemaining,coldRemaining:run.coldRemaining,queueSchemaVersion:6,delta,snapshot,reason:run.stopReason||null,...scheduledRunFields()});
 await savePredictionRun(env,run);
}
const START_EVENT_PREFIX=ENRICHMENT_KEY+'start-events/';
async function runnerStarted(env,run,resumed,queue){
 const snapshot=await predictionEventSnapshot(env,queue,run.batchSize),runState=run.startResult==='recovered_stale_lease'?'recovered':resumed?'resumed':'started';
 run.coverageStartCurrentPredictions=snapshot.coverage?.currentPredictionsTotal??null;await savePredictionRun(env,run);
 const event={id:'prediction-start-'+run.runId,type:'enrichment',at:run.createdAt,startedAt:run.createdAt,stage:resumed?'resumed':'started',runState,title:runState==='recovered'?'Прогнозы восстановлены':resumed?'Прогнозы продолжены':'Прогнозы запущены',queueSchemaVersion:6,hotRemaining:queue?.priorityCount??null,coldRemaining:queue?.coldRemaining??null,currentBatchSize:run.batchSize,delta:{added:0,updated:0,failed:0,predictionGain:0},snapshot};
 const key=START_EVENT_PREFIX+run.runId+'.json';await saveJSON(env,key,{event});await flushStopEvent(env,{event},key);
}
const STOP_EVENT_PREFIX=ENRICHMENT_KEY+'stop-events/';
function systemicReason(reason){
 const text=String(reason||'');if(['quota','model_unavailable','api_error','storage_error','lease_lost','format_error_storm','profile_changed','lease_expired','external_termination','model_error','runner_aborted','time_budget','priority_changed'].includes(text))return text;
 if(/quota|usage|limit/i.test(text))return 'quota';if(/lease/i.test(text))return 'lease_lost';if(/profile|model/i.test(text))return 'model_unavailable';return 'storage_error';
}
async function flushStopEvent(env,record,key){
 if(record.delivered)return true;
 for(let attempt=0;attempt<3;attempt++){try{await writeEvent(env,record.event);if(key){record.delivered=true;await saveJSON(env,key,record);}return true;}catch{}}
 return false;
}
async function recordRunStop(env,id,reason,fallback={}){
 let run=await checkedRun(env,id)||{runId:id,mode:'queued',trigger:fallback.trigger==='scheduled'?'scheduled':'manual',createdAt:new Date().toISOString(),selectedIds:[],results:{},failures:{}};
 if(run.recoveredByRunId){const pending=await loadJSON(env,STOP_EVENT_PREFIX+id+'.json');if(pending&&!pending.delivered)await saveJSON(env,STOP_EVENT_PREFIX+id+'.json',{...pending,delivered:true,superseded:true});return {status:'superseded',runId:id,continuedByRunId:run.recoveredByRunId,mustComplete:false};}
 const key=STOP_EVENT_PREFIX+id+'.json',existing=await loadJSON(env,key);let record=existing;
 if(!record){let queue=null;try{queue=await loadJSON(env,predictionQueueKey);}catch{}const summary=runSummary(run),at=run.event?.at||run.completedAt||new Date().toISOString();
 const snapshot=await predictionEventSnapshot(env,queue,run.batchSize),delta=predictionEventDelta(run,summary,snapshot),event={remaining:queue?(queue.priorityCount||0)+(queue.coldRemaining||0):null,id:run.event?.id||'enrichment-'+id,type:'enrichment',runId:id,at,queueSchemaVersion:6,stage:'partial',title:'Прогнозы приостановлены',reason:systemicReason(reason),stopReason:systemicReason(reason),trigger:run.trigger,added:summary.added,updated:summary.updated,failed:summary.failed,checked:summary.checked,processed:summary.processed,hotProcessed:summary.hotProcessed,coldProcessed:summary.coldProcessed,batchCount:summary.batchCount,batchesProcessed:predictionBatchesProcessed(run),hotRemaining:queue?.priorityCount??fallback.hotRemaining??run.hotRemaining??null,coldRemaining:queue?.coldRemaining??fallback.coldRemaining??run.coldRemaining??null,delta,snapshot};
 record={event};const saved=await env.BUCKET.put(key,JSON.stringify(record),{onlyIf:{etagDoesNotMatch:'*'}});if(saved===null)record=await loadJSON(env,key);
 }
 run.status='partial';run.reason=record.event.reason;run.stopReason=record.event.reason;run.completedAt=record.event.at;run.event=record.event;run.counts={created:record.event.added,recalculated:record.event.updated,failed:record.event.failed,pending:(record.event.hotRemaining||0)+(record.event.coldRemaining||0)};
 if(fallback.callerFault&&!run.callerFault)run.callerFault=fallback.callerFault;
 await saveJSON(env,runKey(id),run);await diagnosticCheckpoint(env,run);const latest=await loadJSON(env,ENRICHMENT_KEY+'latest-run.json');if(!latest||latest.runId===id||fallback.start)await saveJSON(env,ENRICHMENT_KEY+'latest-run.json',run);
 const written=await flushStopEvent(env,record,key);await runnerLease(env,id,'release');return {...record.event,status:'partial',mustComplete:true,eventPending:!written,counts:run.counts};
}
async function recoverStopEvents(env){
 for(const prefix of [STOP_EVENT_PREFIX,START_EVENT_PREFIX]){let cursor;do{const page=await env.BUCKET.list({prefix,limit:100,...(cursor?{cursor}:{})});for(const item of page.objects){const record=await loadJSON(env,item.key);if(record&&!record.delivered){if(prefix===STOP_EVENT_PREFIX)await recordRunStop(env,record.event.runId,record.event.reason);else await flushStopEvent(env,record,item.key);}}cursor=page.truncated?page.cursor:null;}while(cursor);}
}
const PREDICTION_STEP_NAMES=['start','next','submit','heartbeat','complete'];
const CALLER_FAULT_ORIGINS=['worker_http','transport','model_provider','orchestrator','unknown'];
const EXTERNAL_STOPS=['api_error','model_unavailable','model_error','external_termination'];
const NORMAL_COMPLETE=['queue_empty','eligible_queue_empty','parse_error','retry_backoff'];
const FAULT_REASONS=['quota','model_unavailable','api_error','storage_error','lease_lost','format_error_storm','profile_changed','lease_expired','external_termination','model_error','runner_aborted','time_budget','priority_changed'];
function safeRequestId(value){return typeof value==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(value)?value:null;}
function predictionRequestId(request){return safeRequestId(request?.headers?.get?.('X-Request-Id'))||crypto.randomUUID();}
function predictionStep(partial){
 const http=Number.isInteger(partial.httpStatus)&&partial.httpStatus>=100&&partial.httpStatus<=599?partial.httpStatus:null;
 const elapsed=Number.isInteger(partial.elapsedMs)&&partial.elapsedMs>=0&&partial.elapsedMs<=3600000?partial.elapsedMs:null;
 const errorClass=typeof partial.errorClass==='string'&&/^[a-z0-9_]{1,40}$/.test(partial.errorClass)?partial.errorClass:null;
 return {step:PREDICTION_STEP_NAMES.includes(partial.step)?partial.step:'unknown',attemptedAt:partial.attemptedAt||new Date().toISOString(),completedAt:partial.completedAt||null,outcome:['entered','produced','failed'].includes(partial.outcome)?partial.outcome:'entered',httpStatus:http,elapsedMs:elapsed,errorClass,requestId:safeRequestId(partial.requestId),observedBy:'server',delivery:'unconfirmed'};
}
function mergePredictionSteps(existing,incoming){
 const steps=Array.isArray(existing)?existing.slice():[];
 if(incoming){const index=steps.findIndex(step=>step.requestId&&step.requestId===incoming.requestId&&step.step===incoming.step&&step.outcome==='entered');if(index>=0&&incoming.outcome!=='entered')steps[index]=incoming;else if(index<0)steps.push(incoming);}
 return steps.slice(-8);
}
function readCallerFault(body){
 if(!isObject(body)||body.fault==null)return {value:null};
 const fault=body.fault;if(!isObject(fault))return {rejected:true};
 const allowed=['origin','failedStep','providerErrorCode','httpStatus','receivedRequestId'];
 if(Object.keys(fault).some(key=>!allowed.includes(key)))return {rejected:true};
 if(fault.origin!==undefined&&!CALLER_FAULT_ORIGINS.includes(fault.origin))return {rejected:true};
 if(fault.failedStep!==undefined&&!PREDICTION_STEP_NAMES.includes(fault.failedStep))return {rejected:true};
 if(fault.providerErrorCode!==undefined&&(typeof fault.providerErrorCode!=='string'||!/^[A-Za-z0-9_-]{1,40}$/.test(fault.providerErrorCode)||/bearer|token|secret|prompt|stack/i.test(fault.providerErrorCode)))return {rejected:true};
 if(fault.httpStatus!==undefined&&(!Number.isInteger(fault.httpStatus)||fault.httpStatus<100||fault.httpStatus>599))return {rejected:true};
 if(fault.receivedRequestId!==undefined&&!safeRequestId(fault.receivedRequestId))return {rejected:true};
 if(!Object.keys(fault).length)return {value:null};
 return {value:{reportedBy:'caller',attribution:'caller_reported',origin:fault.origin||'unknown',failedStep:fault.failedStep||null,providerErrorCode:fault.providerErrorCode||null,httpStatus:fault.httpStatus??null,receivedRequestId:safeRequestId(fault.receivedRequestId)}};
}
function externalAttribution(reason,fault){
 if(fault)return FAULT_REASONS.includes(reason)?fault:null;
 if(!EXTERNAL_STOPS.includes(reason))return null;
 return {attribution:'external_unattributed',origin:'unknown',reportedBy:null,errorClass:'unknown',failedStep:null,providerErrorCode:null,httpStatus:null,receivedRequestId:null};
}
function presentDiagnostic(row){
 if(!row)return {lastAttemptedStep:null,lastCompletedStep:null,delivery:'unconfirmed',attribution:null,serverFault:null,callerFault:null,steps:[],itemValidation:null};
 const received=row.callerFault?.receivedRequestId||null;
 const steps=(Array.isArray(row.steps)?row.steps:[]).map(step=>({...step,callerAcknowledged:!!(received&&step.requestId&&step.requestId===received)}));
 const lastCompletedStep=row.lastCompletedStep||[...steps].reverse().find(step=>step.outcome==='produced')?.step||null;
 return {...row,steps,lastAttemptedStep:row.lastAttemptedStep||steps.at(-1)?.step||null,lastCompletedStep,delivery:'unconfirmed',attribution:row.callerFault?.attribution||(row.serverFault?'worker_observed':null)};
}
function compactDiagnostics(row){
 const presented=presentDiagnostic(row);
 return {lastAttemptedStep:presented.lastAttemptedStep,lastCompletedStep:presented.lastCompletedStep,delivery:'unconfirmed',attribution:presented.attribution,serverFault:presented.serverFault||null,callerFault:presented.callerFault||null,steps:presented.steps,itemValidation:presented.itemValidation||null};
}
async function safeAppendStep(env,runId,step){
 try{
  if(!runId||String(runId).startsWith('blocked-'))return;
  const run=await loadJSON(env,runKey(runId));const at=run?.diagnosticStartedAt||run?.createdAt;if(!at)return;
  const key=diagnosticKey(runId,at),old=await loadJSON(env,key);if(!old)return;
  const steps=mergePredictionSteps(old.steps,step);
  const serverFault=step.outcome==='failed'||step.errorClass==='lease_lost'||step.errorClass==='storage_error'?{origin:'worker',errorClass:step.errorClass,httpStatus:step.httpStatus,step:step.step}:old.serverFault||null;
  await saveJSON(env,key,{...old,steps,lastAttemptedStep:steps.at(-1)?.step||old.lastAttemptedStep||null,lastCompletedStep:[...steps].reverse().find(item=>item.outcome==='produced')?.step||null,serverFault,callerFault:old.callerFault||run?.callerFault||null,itemValidation:run?.itemValidation||old.itemValidation||null,delivery:'unconfirmed'});
 }catch{}
}
async function withPredictionCorrelation(response,requestId){
 let data;try{data=await response.clone().json();}catch{return response;}
 if(!isObject(data))return response;
 const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Request-Id':requestId};
 return new Response(JSON.stringify({...data,requestId,delivery:'unconfirmed'}),{status:response.status,headers});
}
async function observedPrediction(env,body,work,stage,requestId){
 const correlation=safeRequestId(requestId)||crypto.randomUUID();
 const started=Date.now(),attemptedAt=new Date(started).toISOString(),traceId=body?.diagnosticRunId||body?.runId||null;
 const stopId=()=>body?.runId||'blocked-'+(body?.trigger==='scheduled'?'scheduled':'manual')+'-'+Math.floor(Date.now()/3600000);
 const entered=predictionStep({step:stage,requestId:correlation,attemptedAt,outcome:'entered'});
 await safeAppendStep(env,traceId,entered);
 let response,data;try{response=await work();data=await response.clone().json();}catch(error){
  const id=stopId();
  await safeAppendStep(env,traceId||id,predictionStep({step:stage,requestId:correlation,attemptedAt,outcome:'failed',httpStatus:502,elapsedMs:Date.now()-started,errorClass:'storage_error'}));
  const stop=await recordRunStop(env,id,'storage_error',{start:stage==='start',trigger:body?.trigger});
  return withPredictionCorrelation(json({...stop,error:'storage_error'},502),correlation);
 }
 const normal=['queue_empty','eligible_queue_empty','retry_backoff'];
 const stop=data.status==='lease_lost'?'lease_lost':data.mustComplete&&!normal.includes(data.stopReason)?data.stopReason:data.status==='blocked'&&data.reason!=='retry_backoff'?data.reason:response.status>=500?'storage_error':response.status===409&&data.error?.includes('Profile changed')?'profile_changed':stage==='start'&&response.status===409&&data.error?'model_unavailable':null;
 const errorClass=stop==='lease_lost'||stop==='storage_error'||stop==='format_error_storm'?stop:null;
 const produced=predictionStep({step:stage,requestId:correlation,attemptedAt,completedAt:new Date().toISOString(),outcome:'produced',httpStatus:response.status,elapsedMs:Date.now()-started,errorClass});
 if(stop){const id=stopId();const final=await recordRunStop(env,id,stop,{...data,start:stage==='start',trigger:body?.trigger});await safeAppendStep(env,traceId||id,produced);return withPredictionCorrelation(json({...data,...final,stage:stage==='start'?'blocked':final.stage,status:stage==='start'?'blocked':data.status||'partial'},response.status),correlation);}
 await safeAppendStep(env,traceId,produced);
 return withPredictionCorrelation(response,correlation);
}
async function predictionWriter(env,work){
 const object=await env.BUCKET.get(PREDICTION_MUTATION_LEASE),old=object?await object.json():null;
 if(old?.expiresAt>Date.now())return json({status:'busy',reason:'prediction_writer_busy',...scheduledRunFields()},409);
 const lease={id:crypto.randomUUID(),expiresAt:Date.now()+90000},saved=await env.BUCKET.put(PREDICTION_MUTATION_LEASE,JSON.stringify(lease),{onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});
 if(saved===null)return json({status:'busy',reason:'prediction_writer_busy',...scheduledRunFields()},409);
 try{return await work();}finally{const current=await env.BUCKET.get(PREDICTION_MUTATION_LEASE);if(current&&(await current.json()).id===lease.id)await env.BUCKET.put(PREDICTION_MUTATION_LEASE,JSON.stringify({...lease,expiresAt:0}),{onlyIf:{etagMatches:current.etag}});}
}
// `beforeWrite` lets a lease-holding caller renew its lease immediately before the queue write; other callers pass nothing.
async function refreshPredictionQueue(env,report,trigger='reconcile',beforeWrite=null){
 const pinned=report?.runId?{...env,epgPin:{programmeRunId:report.runId}}:await pinEpg(env);
 const [profile,index,previous,catalog]=await Promise.all([loadJSON(env,profileKey),loadJSON(env,ENRICHMENT_KEY+'view-index.json'),loadJSON(env,predictionQueueKey),loadJSON(pinned,'epg/discovered-films.json')]);
 if(!profile||!report?.films)return null;
 const now=Date.now(),films=allEnrichmentFilms(report,catalog),watchlistIds=new Set(eligibleEnrichmentFilms(report).map(f=>String(f.id))),priority=Object.fromEntries(films.map(f=>[String(f.id),predictionPriority(f,now)]));
 // The selective profile rule decides; the strict outcome is counted for every film beside it.
 const mode=PREDICTION_PROFILE_MODE,digest=await profileLineageDigests(profile),fresh=new Map(),compatibility={mode,evaluatorVersion:PREDICTION_COMPATIBILITY_VERSION,profileVersion:profile.version,films:films.length,missing:0,strict:{current:0,stale:0},selective:{current:0,compatible:0,stale:0},reasons:{},wouldKeep:0,wouldRequeue:0,strictDisagreements:0};
 // The fingerprint transition rule (ADR-0035) decides; the strict fingerprint outcome is counted beside it. Each outstanding
 // film gets a work class: missing (no prediction), prediction_only, fingerprint_and_prediction; a class from a transition is migration work, bounded per batch; unknown counts the fail-closed outcomes.
 const fingerprintMode=PREDICTION_FINGERPRINT_MODE,registry=await fingerprintRegistryDigests(),transitionOptions=fingerprintEvaluatorOptions(text=>registry.lookup(text)??digest(text)),target=fingerprintTarget(),work={};
 const fingerprintCompatibilityBlock={mode:fingerprintMode,evaluatorVersion:FINGERPRINT_COMPATIBILITY_VERSION,registryDigest:registry.registry,target,films:films.length,unindexed:0,strict:{current:0,stale:0},selective:{current:0,compatible:0,stale:0},reasons:{},fingerprintReasons:{},migration:{none:0,compatible:0,partial:0,full:0,global:0},classes:{unchanged:0,missing:0,prediction_only:0,fingerprint_and_prediction:0,migration:0,unknown:0},wouldKeep:0,wouldRequeue:0,strictDisagreements:0};
 const judge=(item,film)=>{
  const record=indexedFingerprintRecord(item),genres=film?.genres;
  const selective=predictionTransitionCompatibility(item?.prediction,record,{genres},profile,FINGERPRINT_TRANSITIONS,target,{fingerprint:'selective',prompt:'selective',profile:mode},transitionOptions);
  const strict=predictionTransitionCompatibility(item?.prediction,record,{genres},profile,FINGERPRINT_TRANSITIONS,target,{fingerprint:'strict',prompt:'strict',profile:mode},transitionOptions);
  return {selective,strict};
 };
 for(const film of films){
  const id=String(film.id),item=index?.[id];
  if(item?.fingerprintHash&&!indexedFingerprintRecord(item))fingerprintCompatibilityBlock.unindexed++;
  const verdicts=item?.fingerprintHash?judge(item,film):null;
  if(verdicts){
   const f=fingerprintCompatibilityBlock,strictFresh=predictionCompatibilityFresh(verdicts.strict),selectiveFresh=predictionCompatibilityFresh(verdicts.selective),fv=verdicts.selective.fingerprint;
   f.strict[strictFresh?'current':'stale']++;f.selective[verdicts.selective.outcome]++;f.reasons[verdicts.selective.reason]=(f.reasons[verdicts.selective.reason]||0)+1;f.fingerprintReasons[fv.reason]=(f.fingerprintReasons[fv.reason]||0)+1;f.migration[fv.migration]++;
   if(!strictFresh&&selectiveFresh)f.wouldKeep++;if(strictFresh&&!selectiveFresh)f.wouldRequeue++;
  }
  if(!item?.prediction){compatibility.missing++;fresh.set(id,false);fingerprintCompatibilityBlock.classes.missing++;work[id]={class:'missing',requiredWork:item?.fingerprintHash&&predictionCompatibilityFresh(verdicts.selective.fingerprint)?'prediction_only':'fingerprint_and_prediction',migration:null,reason:null};continue;}
  const strict=indexedPredictionCurrent(item,profile),selective=indexedPredictionCompatibility(item,film,profile,'selective',digest),strictEvaluated=predictionCompatibilityFresh(indexedPredictionCompatibility(item,film,profile,'strict',digest));
  compatibility.strict[strict?'current':'stale']++;compatibility.selective[selective.outcome]++;compatibility.reasons[selective.reason]=(compatibility.reasons[selective.reason]||0)+1;
  if(!strict&&predictionCompatibilityFresh(selective))compatibility.wouldKeep++;
  if(strict&&!predictionCompatibilityFresh(selective))compatibility.wouldRequeue++;
  if(strictEvaluated!==strict)compatibility.strictDisagreements++;
  const chosen=verdicts.selective,decided=predictionCompatibilityFresh(chosen);
  if(chosen&&predictionCompatibilityFresh(chosen)!==decided)fingerprintCompatibilityBlock.strictDisagreements++;
  fresh.set(id,decided);
  if(decided){fingerprintCompatibilityBlock.classes.unchanged++;continue;}
  const fv=chosen.fingerprint,migration=!predictionCompatibilityFresh(fv)||chosen.reason?.startsWith('prompt_')?fv.migration==='none'?'prediction':fv.migration:null,unknown=['transition_unknown','transition_impact_unknown','film_features_unknown','prompt_transition_unknown','prompt_features_unknown'].includes(chosen.reason);
  fingerprintCompatibilityBlock.classes[chosen.requiredWork]++;if(migration)fingerprintCompatibilityBlock.classes.migration++;if(unknown)fingerprintCompatibilityBlock.classes.unknown++;
  work[id]={class:chosen.requiredWork,requiredWork:chosen.requiredWork,migration,reason:chosen.reason,...(fv.fields?{fields:fv.fields}:{})};
 }
 const missing=films.filter(f=>!fresh.get(String(f.id)));
 missing.sort((a,b)=>{const x=priority[a.id],y=priority[b.id];return x.rank-y.rank||(x.rank===0?x.expiresInMs-y.expiresInMs:0)||Number(y.availableNow||y.availableToday)-Number(x.availableNow||x.availableToday)||Number(!!index?.[a.id]?.prediction)-Number(!!index?.[b.id]?.prediction)||Number(!!work[a.id]?.migration)-Number(!!work[b.id]?.migration)||(Date.parse(b.hotEnteredAt||b.discoveredAt)||0)-(Date.parse(a.hotEnteredAt||a.discoveredAt)||0)||String(a.id).localeCompare(String(b.id),'en');});
 const hotPending=missing.filter(f=>priority[f.id].hot).map(f=>String(f.id)),coldPending=missing.filter(f=>!priority[f.id].hot).map(f=>String(f.id)),pending=[...hotPending,...coldPending.filter(id=>watchlistIds.has(id))],currentIds=new Set(missing.map(f=>String(f.id))),retries=Object.fromEntries(Object.entries(previous?.retries||{}).filter(([id])=>currentIds.has(id)));
 const hotCount=films.filter(f=>priority[f.id].hot).length,hotPredicted=hotCount-hotPending.length,hotCatalogPredicted=films.filter(f=>priority[f.id].hot&&!watchlistIds.has(String(f.id))&&fresh.get(String(f.id))).length,addedHot=previous?.hotPending?hotPending.filter(id=>!previous.hotPending.includes(id)).length:0;
 const queue={schemaVersion:3,hotCount,coldCount:films.length-hotCount,coldWithoutPrediction:coldPending.filter(id=>!watchlistIds.has(id)).length,hotPredicted,profileVersion:profile.version,profileHash:profile.profileHash,programmeRunId:report.runId,refreshedAt:new Date().toISOString(),trigger,pending,hotPending,coldPending,priorityCount:hotPending.length,coldRemaining:coldPending.length,urgentCount:hotPending.filter(id=>priority[id].rank===0).length,priority:Object.fromEntries(missing.map(f=>[String(f.id),priority[f.id]])),retries,lastBatch:previous?.lastBatch||null,lastCheckAt:previous?.lastCheckAt||null,metrics:{hotAddedTotal:(previous?.metrics?.hotAddedTotal||0)+addedHot,hotProcessedTotal:previous?.metrics?.hotProcessedTotal||0},compatibility,fingerprintCompatibility:fingerprintCompatibilityBlock,fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,fingerprintPromptVersion:FINGERPRINT_PROMPT_VERSION,predictionPromptVersion:PREDICTION_PROMPT_VERSION,work:Object.fromEntries(pending.map(id=>[id,work[id]]).filter(([,w])=>w)),discovery:{ready:hotCatalogPredicted>=100,minimum:100,target:200,hotPredicted:hotCatalogPredicted,reason:hotCatalogPredicted>=100?'usable_hot_sample':'warming_hot_sample'}};
 if(beforeWrite)await beforeWrite();await saveJSON(env,predictionQueueKey,queue);return queue;
}
async function queueStatus(env){return queueStatusView(await loadJSON(env,predictionQueueKey));}
function queueStatusView(q){return q?{schemaVersion:q.schemaVersion,hotCount:q.hotCount,coldCount:q.coldCount,coldWithoutPrediction:q.coldWithoutPrediction,hotPredicted:q.hotPredicted,profileVersion:q.profileVersion,programmeRunId:q.programmeRunId,refreshedAt:q.refreshedAt,pendingCount:q.pending.length,priorityCount:q.priorityCount,hotRemaining:q.priorityCount,coldRemaining:q.coldRemaining??q.coldWithoutPrediction??0,urgentCount:q.urgentCount||0,adaptiveBatch:adaptivePredictionBatch(q),compatibility:q.compatibility||null,fingerprintCompatibility:q.fingerprintCompatibility||null,fingerprintSchemaVersion:q.fingerprintSchemaVersion??null,fingerprintPromptVersion:q.fingerprintPromptVersion??null,predictionPromptVersion:q.predictionPromptVersion??null,discovery:q.discovery||null,metrics:q.metrics||null,lastBatch:q.lastBatch,lastCheckAt:q.lastCheckAt,...scheduledRunFields()}:null;}
function canonicalCoverageSummary(report,catalog,index,profile,now=Date.now(),freshness=strictFreshness(profile)){
 const groups=new Map();
 for(const film of [...(report?.films||[]),...Object.values(catalog||{})]){
  const tmdbId=String(film?.tmdbId||'').trim();if(!tmdbId)continue;
  const identity='tmdb:'+tmdbId,group=groups.get(identity)||{ids:new Set(),films:[]};
  group.ids.add(String(film.id));group.films.push(film);group.byId=group.byId||new Map();if(!group.byId.has(String(film.id)))group.byId.set(String(film.id),film);groups.set(identity,group);
 }
 let currentPredictionsTotal=0,windowFilmsTotal=0,windowCurrentPredictions=0,cacheOffWindowTotal=0,pendingOffWindowTotal=0;
 for(const group of groups.values()){
  const current=[...group.ids].some(id=>freshness.indexed(index?.[id],group.byId.get(id)));
  const inWindow=group.films.some(film=>filmIsHot(film,now));
  if(current)currentPredictionsTotal++;
  if(inWindow){windowFilmsTotal++;if(current)windowCurrentPredictions++;}
  else{cacheOffWindowTotal++;if(!current)pendingOffWindowTotal++;}
 }
 return {confirmedFilmsTotal:groups.size,currentPredictionsTotal,windowFilmsTotal,windowCurrentPredictions,cacheOffWindowTotal,pendingOffWindowTotal};
}
function coveragePercent(current,total){if(!total)return 100;if(current===total)return 100;const tenths=Math.round(current/total*1000);return tenths>=1000?99.9:tenths/10;}
function predictionBatchesProcessed(run){return Math.max(0,(run.batchCount||1)-1)+(run.selectedIds?.length&&run.selectedIds.every(id=>run.results?.[id])?1:0);}
// Read-only slices of the stored queue: outstanding work, the part the runner would take now and the part a retry
// timestamp defers. `nextRetryAt` is the earliest numeric retryAt of a deferred outstanding film, not a schedule time.
function predictionQueueSlices(queue,now=Date.now()){
 if(!Array.isArray(queue?.hotPending)||!Array.isArray(queue?.coldPending))return {hotPending:queue?.priorityCount??null,coldPending:queue?.coldRemaining??null,outstanding:null,eligibleNow:null,deferredByRetry:null,nextRetryAt:null};
 const outstanding=[...new Set([...queue.hotPending,...queue.coldPending])],deferred=outstanding.filter(id=>queue.retries?.[id]?.retryAt>now),nextMs=deferred.map(id=>queue.retries[id].retryAt).filter(value=>typeof value==='number').sort((a,b)=>a-b)[0];
 return {hotPending:queue.hotPending.length,coldPending:queue.coldPending.length,outstanding:outstanding.length,eligibleNow:queueReadyIds(queue,now).length,deferredByRetry:deferred.length,nextRetryAt:Number.isFinite(nextMs)?new Date(nextMs).toISOString():null};
}
async function predictionEventSnapshot(env,queue,batchSize=null){
 const safe=async key=>{try{return await loadJSON(pinned,key);}catch{return null;}},pinned=await pinEpg(env),[profile,index,report,catalog,persistedQueue]=await Promise.all([safe(profileKey),safe(ENRICHMENT_KEY+'view-index.json'),safe('programme.json'),safe('epg/discovered-films.json'),queue===undefined||queue===null?safe(predictionQueueKey):queue]);
 const coverage=canonicalCoverageSummary(report,catalog,index,profile,Date.now(),await predictionFreshness(env,profile));
 return {coverage:{...coverage,localPercent:coveragePercent(coverage.currentPredictionsTotal,coverage.confirmedFilmsTotal),windowPercent:coveragePercent(coverage.windowCurrentPredictions,coverage.windowFilmsTotal)},queue:predictionQueueSlices(persistedQueue),...(Number.isInteger(batchSize)&&batchSize>0?{currentBatchSize:batchSize}:{})};
}
function predictionEventDelta(run,summary,snapshot){const current=snapshot?.coverage?.currentPredictionsTotal,start=run.coverageStartCurrentPredictions;return {added:summary.added,updated:summary.updated,failed:summary.failed,predictionGain:Number.isInteger(current)&&Number.isInteger(start)?current-start:null};}
const INTEGRATION_STALE_MS=48*3600000;
function integrationTime(value){const ms=Date.parse(value);return Number.isFinite(ms)?new Date(ms).toISOString():null;}
function integrationEntry(id,role,state,code,lastSuccessAt,lastFailureAt){return {id,role,state,code,lastSuccessAt:lastSuccessAt||null,lastFailureAt:lastFailureAt||null};}
function ratingsFailureCode(kind){if(kind==='blocked'||kind==='anti_bot')return 'ratings_blocked';if(kind==='http_429')return 'ratings_rate_limit';if(kind==='degraded'||kind==='incomplete')return 'ratings_incomplete';if(kind==='lookup_failed'||kind==='publish_failed'||kind==='failed')return 'ratings_failed';return null;}
function ratingsMessageCode(message){if(/403|anti-bot/i.test(message))return 'ratings_blocked';if(/429/.test(message))return 'ratings_rate_limit';if(/incomplete|pagination changed|duplicate letterboxd/i.test(message))return 'ratings_incomplete';return 'ratings_failed';}
function resolverMatches(programmeRunId,reportRunId){if(!programmeRunId||!reportRunId)return true;return programmeRunId===reportRunId;}
function integrationHealth({sync,ratings,enabled,report,continuation,discoveryStatus,run,live,now,watchlistIngest}){
 const age=value=>{const at=integrationTime(value);return at?now-Date.parse(at):null;};
 const fresh=value=>age(value)>INTEGRATION_STALE_MS?'stale':'healthy',freshCode=value=>fresh(value)==='stale'?'stale':'ok';
 const watchlistSuccess=[sync?.stage==='complete'&&!sync.error?integrationTime(sync.updatedAt):null,integrationTime(report?.watchlistUpdatedAt),integrationTime(watchlistIngest?.lastSuccessAt)].filter(Boolean).sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1)||null;
 const watchlistFailure=integrationTime(watchlistIngest?.failedAt);
 const watchlist=(()=>{
  if(watchlistFailure&&(!watchlistSuccess||Date.parse(watchlistFailure)>Date.parse(watchlistSuccess)))return integrationEntry('letterboxd_watchlist','source','failed','watchlist_failed',watchlistSuccess,watchlistFailure);
  if(sync?.error&&/watchlist/i.test(sync.error))return integrationEntry('letterboxd_watchlist','source','failed','watchlist_failed',integrationTime(report?.watchlistUpdatedAt)||watchlistSuccess,integrationTime(sync.updatedAt));
  if(sync?.stage==='complete'&&!sync.error)return integrationEntry('letterboxd_watchlist','source',fresh(sync.updatedAt),freshCode(sync.updatedAt),integrationTime(sync.updatedAt),null);
  if(sync&&['metadata','epg'].includes(sync.stage)&&!sync.error){const elapsed=age(sync.updatedAt);return elapsed!=null&&elapsed<15*60000?integrationEntry('letterboxd_watchlist','source','running','running',watchlistSuccess,null):integrationEntry('letterboxd_watchlist','source','degraded','watchlist_stuck',watchlistSuccess,integrationTime(sync.updatedAt));}
  if(sync?.error){const prior=integrationTime(report?.watchlistUpdatedAt);if(!prior)return integrationEntry('letterboxd_watchlist','source','unknown','no_data',null,null);return integrationEntry('letterboxd_watchlist','source',fresh(prior),freshCode(prior),prior,null);}
  return integrationEntry('letterboxd_watchlist','source','unknown','no_data',null,null);
 })();
 // Current ratings health comes only from the routine EPG commit's sync.json fields. The retired ratings-only refresh's
 // frozen status document is reported separately as history and never decides the current state (ADR 0040).
 const ratingEvents=[],ratingPending=sync?.stage==='complete'&&Array.isArray(sync.ratingPending)&&sync.ratingPending.length>0;
 if(integrationTime(sync?.ratingObservedAt))ratingEvents.push({at:integrationTime(sync.ratingObservedAt),ok:true});
 if(typeof sync?.ratingError==='string'&&sync.ratingError&&integrationTime(sync.updatedAt))ratingEvents.push({at:integrationTime(sync.updatedAt),ok:false,code:ratingsMessageCode(sync.ratingError)});
 ratingEvents.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||(a.ok===b.ok?0:a.ok?-1:1));
 const latestRating=ratingEvents.at(-1),ratingSuccess=ratingEvents.filter(item=>item.ok).at(-1)?.at||null,ratingFailureAt=ratingEvents.filter(item=>!item.ok).at(-1)?.at||null;
 const retiredCode=ratingsFailureCode(ratings?.state)||ratingsFailureCode(ratings?.attempt?.cause),retiredRefresh=ratings&&typeof ratings==='object'?{state:'retired',lastOutcome:retiredCode?'failed':integrationTime(ratings.lastSuccessAt)?'succeeded':'unknown',code:retiredCode,lastSuccessAt:integrationTime(ratings.lastSuccessAt),lastFailureAt:retiredCode?integrationTime(ratings.lastFailureAt):null}:null;
 const ratingsSource=(()=>{
  const entry=(state,code,success,failure,extra={})=>({...integrationEntry('letterboxd_ratings','source',state,code,success,failure),...extra,manualRefreshEnabled:!!enabled,retiredRefresh});
  const pendingSince=integrationTime(sync?.updatedAt);
  if(ratingPending&&(!latestRating||latestRating.ok&&(!pendingSince||Date.parse(latestRating.at)<=Date.parse(pendingSince))))return entry('degraded','ratings_pending',ratingSuccess,ratingFailureAt,{pendingSince});
  if(!latestRating)return entry('unknown','no_data',null,null);
  if(!latestRating.ok)return entry(latestRating.code==='ratings_failed'?'failed':'degraded',latestRating.code,ratingSuccess,ratingFailureAt);
  return entry(fresh(ratingSuccess),freshCode(ratingSuccess),ratingSuccess,ratingFailureAt);
 })();
 const epgFailure=sync?.error?integrationTime(sync.updatedAt):null,epgPrevious=integrationTime(report?.updatedAt),epgSuccess=sync?.stage==='complete'&&!sync.error?integrationTime(sync.updatedAt):epgFailure&&epgPrevious&&Date.parse(epgPrevious)<Date.parse(epgFailure)?epgPrevious:null;
 const epg=(()=>{
  if(sync?.error){const code=/HTTP/i.test(sync.error)?'epg_http':/cover the current window/i.test(sync.error)?'epg_window':/parse|xml|unexpected/i.test(sync.error)?'epg_parse':'epg_failed';return integrationEntry('epg','source','failed',code,epgSuccess,epgFailure);}
  if(sync?.stage==='complete')return integrationEntry('epg','source',fresh(sync.updatedAt),freshCode(sync.updatedAt),integrationTime(sync.updatedAt),null);
  if(sync&&['metadata','epg'].includes(sync.stage)){const elapsed=age(sync.updatedAt);return elapsed!=null&&elapsed<15*60000?integrationEntry('epg','source','running','running',epgSuccess,null):integrationEntry('epg','source','degraded','epg_failed',epgSuccess,integrationTime(sync.updatedAt));}
  return integrationEntry('epg','source','unknown','no_data',null,null);
 })();
 const reportRunId=report?.runId||null,resolverConfirmed=[];
 if(discoveryStatus?.stage==='complete'&&!discoveryStatus.error){const at=integrationTime(discoveryStatus.finishedAt||discoveryStatus.at);if(at)resolverConfirmed.push({at,current:resolverMatches(discoveryStatus.programmeRunId,reportRunId)});}
 if(continuation?.stage==='complete'){const at=integrationTime(continuation.at);if(at)resolverConfirmed.push({at,current:resolverMatches(continuation.programmeRunId,reportRunId)});}
 const byTime=(a,b)=>Date.parse(a)-Date.parse(b),priorResolverSuccess=resolverConfirmed.map(item=>item.at).sort(byTime).at(-1)||null,currentResolverSuccess=resolverConfirmed.filter(item=>item.current).map(item=>item.at).sort(byTime).at(-1)||null;
 const resolverProgress=()=>{const elapsed=age(continuation?.at);return integrationEntry('resolver','source',elapsed>INTEGRATION_STALE_MS?'stale':'running',elapsed>INTEGRATION_STALE_MS?'stale':'running',priorResolverSuccess,null);};
 const resolver=(()=>{
  if(continuation?.reason==='missing_secret')return integrationEntry('resolver','source','degraded','resolver_unconfigured',priorResolverSuccess,null);
  if(['epg_committed','chunk_budget','busy'].includes(continuation?.reason)||continuation?.stage==='running')return resolverProgress();
  if(continuation?.reason==='backoff'||continuation?.retryAt&&Date.parse(continuation.retryAt)>now)return integrationEntry('resolver','source','degraded','resolver_backoff',priorResolverSuccess,integrationTime(continuation.at));
  if(continuation?.stage==='error')return integrationEntry('resolver','source','failed','resolver_failed',priorResolverSuccess,integrationTime(continuation.at));
  if(discoveryStatus?.error&&resolverMatches(discoveryStatus.programmeRunId,reportRunId))return integrationEntry('resolver','source','failed','resolver_failed',priorResolverSuccess,integrationTime(discoveryStatus.finishedAt||discoveryStatus.at));
  if(discoveryStatus?.stage==='partial'&&resolverMatches(discoveryStatus.programmeRunId,reportRunId))return resolverProgress();
  if(continuation?.stage==='paused'&&continuation.reason==null&&continuation.remainingChunks>0)return resolverProgress();
  if(currentResolverSuccess)return integrationEntry('resolver','source',fresh(currentResolverSuccess),freshCode(currentResolverSuccess),currentResolverSuccess,null);
  return integrationEntry('resolver','source','unknown','no_data',null,null);
 })();
 const runStatus=!run?'idle':live?'running':run.status==='running'?'blocked':run.status==='partial'?'blocked':run.status==='complete'?'completed':run.status||'idle';
 const predictionSuccess=['completed'].includes(runStatus)?integrationTime(run.completedAt):null,predictionFailure=['blocked','interrupted'].includes(runStatus)?integrationTime(run.completedAt||run.createdAt):null;
 const predictions=runStatus==='idle'?integrationEntry('predictions','capability','unknown','no_data',null,null):runStatus==='running'?integrationEntry('predictions','capability','running','running',null,null):runStatus==='interrupted'?integrationEntry('predictions','capability','degraded','prediction_interrupted',null,predictionFailure):runStatus==='blocked'?integrationEntry('predictions','capability','degraded','prediction_blocked',null,predictionFailure):run?.failures&&Object.keys(run.failures).length?integrationEntry('predictions','capability','degraded','prediction_partial',predictionSuccess,predictionFailure):integrationEntry('predictions','capability',fresh(predictionSuccess),freshCode(predictionSuccess),predictionSuccess,null);
 const films=report?.watchlistCount||report?.films?.length||0,missing=(report?.stats?.metadataMissing||0)+(report?.stats?.titleMissing||0)+(report?.stats?.titleProvisional||0);
 const sources=[watchlist,ratingsSource,epg,resolver,predictions];
 if(films>=10&&missing/films>=.2)sources.push(integrationEntry('metadata','source','degraded','metadata_attention',null,null));
 const failed=sources.filter(item=>item.state==='failed').length,attention=sources.filter(item=>!['healthy','off','running'].includes(item.state)).length;
 return {aggregate:failed?'failed':attention?'attention':'healthy',attentionCount:attention,failedCount:failed,sources};
}
async function footerStatus(env){
 const pinned=await pinEpg(env);
 const [profile,index,report,catalog,storedQueue,run,lease,source,decisions,sync,ratings,discoveryStatus,continuation,watchlistIngest]=await Promise.all([
  loadJSON(env,profileKey),loadJSON(env,ENRICHMENT_KEY+'view-index.json'),loadJSON(pinned,'programme.json'),loadJSON(pinned,'epg/discovered-films.json'),loadJSON(env,predictionQueueKey),loadJSON(env,ENRICHMENT_KEY+'latest-run.json'),loadJSON(env,RUNNER_LEASE_KEY),loadJSON(pinned,'epg/discovery-latest.json'),loadJSON(env,'epg/discovery-resolution.json'),loadJSON(env,'sync.json'),loadJSON(env,RATINGS_STATUS_KEY),loadJSON(env,'epg/discovery-status.json'),loadJSON(env,'epg/resolver-continuation.json'),loadJSON(env,'watchlist-ingest.json')
 ]);
 const coverage=canonicalCoverageSummary(report,catalog,index,profile,Date.now(),await predictionFreshness(env,profile)),items=source?.items||[],queue=queueStatusView(storedQueue),slices=predictionQueueSlices(storedQueue);
 const recognized=new Set();
 for(const candidate of items){const decision=decisions?.[candidate.key];if(decision?.status==='verified'&&decision.tmdbId)recognized.add(String(decision.tmdbId));}
 const counts=ledgerCounts(source,decisions||{},Date.now());
 const pendingRecognition=counts.currentUnresolved,historicalUnresolved=counts.historicalUnresolved+counts.expiredInactive;
 const live=run?.status==='running'&&lease?.runId===run.runId&&lease.expiresAt>Date.now(),summary=run?runSummary(run):null;
 const runStatus=!run?'idle':live?'running':run.status==='running'?'blocked':run.status==='partial'?'blocked':run.status==='complete'?'completed':run.status||'idle';
 const rawReason=run?.stopReason||run?.reason,reason=['queue_empty','eligible_queue_empty','retry_backoff'].includes(rawReason)?rawReason:safePredictionReason(rawReason);
 return {schemaVersion:1,generatedAt:new Date().toISOString(),profile:profile?{version:profile.version,updatedAt:profile.updatedAt}:null,coverage:{...coverage,localPercent:coveragePercent(coverage.currentPredictionsTotal,coverage.confirmedFilmsTotal),windowPercent:coveragePercent(coverage.windowCurrentPredictions,coverage.windowFilmsTotal),windowPendingTotal:coverage.windowFilmsTotal-coverage.windowCurrentPredictions},predictions:{pendingHot:queue?.hotRemaining??coverage.windowFilmsTotal-coverage.windowCurrentPredictions,pendingCold:queue?.coldRemaining??coverage.pendingOffWindowTotal,outstanding:slices.outstanding,eligibleNow:slices.eligibleNow,deferredByRetry:slices.deferredByRetry,nextRetryAt:slices.nextRetryAt,pendingOffWindow:coverage.pendingOffWindowTotal,currentBatch:live?{size:run.batchSize??run.selectedIds?.length??null}:null,nextBatchSize:queue?.adaptiveBatch?.batchSize??0,nextScheduledRun:hourlyTaskRunAt()},epgTmdb:{recognizedFilms:recognized.size,pendingRecognition,historicalUnresolved,ledgerTotal:counts.ledgerTotal,confirmedMovies:coverage.confirmedFilmsTotal,cacheOffWindow:coverage.cacheOffWindowTotal,epgStart:report?.stats?.epgStart??null,epgEnd:report?.stats?.epgEnd??null,channels:report?.stats?.channels??null,checkedTransmissions:report?.stats?.scanned??null},watchlist:{films:report?.watchlistCount??report?.films?.length??0,updatedAt:report?.watchlistUpdatedAt||report?.updatedAt||null,titleMissing:report?.stats?.titleMissing??0,titleProvisional:report?.stats?.titleProvisional??0,metadataMissing:report?.stats?.metadataMissing??0},lastRun:run?{status:runStatus,reason,startedAt:run.createdAt||null,finishedAt:run.completedAt||null,added:summary?.added||0,failed:summary?.failed||0}:null,integrations:integrationHealth({sync,ratings,enabled:false,report,continuation,discoveryStatus,run,live,now:Date.now(),watchlistIngest})};
}
function queueReadyIds(queue,now=Date.now()){const ids=queue.priorityCount?queue.hotPending:queue.coldPending;return (ids||queue.pending||[]).filter(id=>!(queue.retries?.[id]?.retryAt>now));}
// The ids a batch takes, in queue order: migration work (ADR-0035 section 6) fills at most FINGERPRINT_MIGRATION_SHARE of the
// slots, rounded up; the other slots go to missing work. Slots migration cannot fill stay empty rather than widening the share.
function queueBatchIds(queue,ready,slots){
 const cap=Math.ceil(slots*FINGERPRINT_MIGRATION_SHARE),taken=[];let migration=0;
 for(const id of ready){if(taken.length>=slots)break;if(queue.work?.[id]?.migration){if(migration>=cap)continue;migration++;}taken.push(id);}
 return taken;
}
const RUN_DIAGNOSTICS_PREFIX=ENRICHMENT_KEY+'run-diagnostics/';
function diagnosticKey(id,at){return RUN_DIAGNOSTICS_PREFIX+String(9999999999999-Date.parse(at)).padStart(13,'0')+'-'+id+'.json';}
async function diagnosticCheckpoint(env,run,patch={}){
 if(run.runId.startsWith('blocked-'))return null; // Aggregate stop Events are not additional trigger attempts.
 const at=run.diagnosticStartedAt||run.createdAt,key=diagnosticKey(run.runId,at),old=await loadJSON(env,key),queue=await loadJSON(env,predictionQueueKey),lease=await loadJSON(env,RUNNER_LEASE_KEY),summary=runSummary(run);
 const value={runId:run.runId,trigger:run.trigger==='scheduled'?'scheduled':'manual',startedAt:at,endedAt:run.completedAt||null,state:run.status==='complete'?'completed':run.status==='partial'?'blocked':run.status||'running',startResult:old?.startResult||run.startResult||'running',stopReason:run.stopReason||run.reason||null,leaseAcquiredAt:old?.leaseAcquiredAt||run.leaseAcquiredAt||null,leaseExpiredAt:lease?.runId===run.runId?new Date(lease.expiresAt||Date.parse(old?.leaseExpiredAt||at)).toISOString():old?.leaseExpiredAt||null,lastHeartbeatAt:run.lastHeartbeatAt||old?.lastHeartbeatAt||null,firstNextAt:run.firstNextAt||old?.firstNextAt||null,firstSubmitAt:run.firstSubmitAt||old?.firstSubmitAt||null,added:summary.added,failed:summary.failed,hotRemaining:queue?.priorityCount??run.hotRemaining??null,coldRemaining:queue?.coldRemaining??run.coldRemaining??null,batchesProcessed:Math.max(0,(run.batchCount||1)-1)+(run.selectedIds?.length&&run.selectedIds.every(id=>run.results?.[id])?1:0),...patch,steps:Array.isArray(old?.steps)?old.steps.slice(-8):[],lastAttemptedStep:old?.lastAttemptedStep||null,lastCompletedStep:old?.lastCompletedStep||null,serverFault:old?.serverFault||null,callerFault:run.callerFault||old?.callerFault||null,itemValidation:run.itemValidation||old?.itemValidation||null,delivery:'unconfirmed'};
 await saveJSON(env,key,value);return value;
}
async function diagnosticHistory(env,limit=10){
 const page=await env.BUCKET.list({prefix:RUN_DIAGNOSTICS_PREFIX,limit}),rows=[];
 for(const item of page.objects){let row=await loadJSON(env,item.key);if(!row)continue;if(row.state==='running'&&row.leaseExpiredAt&&Date.parse(row.leaseExpiredAt)<=Date.now()){const run=await checkedRun(env,row.runId);if(run){run.status='interrupted';run.recoverable=true;run.stopReason='lease_expired';run.reason='lease_expired';run.completedAt=row.leaseExpiredAt;await saveJSON(env,runKey(run.runId),run);row=await diagnosticCheckpoint(env,run);}else{row={...row,state:'interrupted',stopReason:row.leaseAcquiredAt?'lease_expired':'runner_aborted',endedAt:row.leaseExpiredAt};await saveJSON(env,item.key,row);}}rows.push(row);}
 return {runs:rows.sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt)||b.runId.localeCompare(a.runId)).slice(0,limit).map(presentDiagnostic)};
}
async function diagnosedStart(env,body,requestId){
 const runId=crypto.randomUUID(),at=new Date().toISOString(),shell={runId,createdAt:at,diagnosticStartedAt:at,trigger:body.trigger==='scheduled'?'scheduled':'manual',status:'starting',selectedIds:[],results:{},failures:{}};
 await diagnosticCheckpoint(env,shell,{startResult:'error'});
 const response=await observedPrediction(env,{...body,diagnosticRunId:runId},async()=>{
  const lease=await runnerLease(env,runId,'acquire');if(lease.status!=='owned')return json(lease);
  shell.leaseAcquiredAt=lease.heartbeatAt;shell.lastHeartbeatAt=lease.heartbeatAt;const previous=lease.recoveredRunId?await checkedRun(env,lease.recoveredRunId):null;shell.startResult=previous&&['running','interrupted'].includes(previous.status)?'recovered_stale_lease':'running';await diagnosticCheckpoint(env,shell,{state:'running',startResult:shell.startResult});
  try{const result=await predictionWriter(env,()=>enrichmentStart(env,body,{...lease,diagnosticStartedAt:at,startResult:shell.startResult}));if(result.status>=400)await runnerLease(env,runId,'release');return result;}catch(error){await runnerLease(env,runId,'release');throw error;}
 },'start',requestId);
 const data=await response.clone().json();if(data.status!=='running'){shell.status=data.status==='already_running'?'completed':data.status==='noop'?'idle':'blocked';shell.completedAt=new Date().toISOString();shell.stopReason=data.stopReason||data.reason||(data.error?'storage_error':null);await diagnosticCheckpoint(env,shell,{startResult:['already_running','blocked','noop'].includes(data.status)?data.status:'error',leaseAcquiredAt:shell.leaseAcquiredAt||null,lastHeartbeatAt:shell.lastHeartbeatAt||null});}
 return response;
}
async function savePredictionRun(env,run){await saveJSON(env,runKey(run.runId),run);await saveJSON(env,ENRICHMENT_KEY+'latest-run.json',run);await diagnosticCheckpoint(env,run);}
async function enrichmentStart(env,body,acquired=null){
 const mode=body.mode||'queued';if(!['watchlist_available','watchlist_all'].includes(body?.scope)||(body.limit!==undefined&&(!Number.isInteger(body.limit)||body.limit<1))||!['queued','legacy'].includes(mode)||(body.batchSize!==undefined&&(!Number.isInteger(body.batchSize)||body.batchSize<1||body.batchSize>MAX_PREDICTION_BATCH)))return json({error:'Invalid scope, mode or batchSize'},400);
 if(body.capacity!==undefined&&(!isObject(body.capacity)||body.capacity.remainingPercent!==undefined&&(!Number.isFinite(body.capacity.remainingPercent)||body.capacity.remainingPercent<0||body.capacity.remainingPercent>100)))return json({error:'Invalid capacity'},400);
 const [profile,report,sync]=await Promise.all([loadJSON(env,profileKey),loadJSON(env,'programme.json'),loadJSON(env,'sync.json')]);if(!profile)return json({error:'Taste profile is not configured'},409);if(!report?.runId||!report?.films||!sync||sync.stage!=='complete'&&sync.runId===report.runId)return json({error:'No completed programme snapshot'},409);
 const catalog=mode==='queued'?await loadJSON(env,'epg/discovered-films.json'):null,eligible=mode==='queued'?allEnrichmentFilms(report,catalog):eligibleEnrichmentFilms(report),queue=mode==='queued'?await refreshPredictionQueue(env,report,body.trigger==='scheduled'?'scheduled':'manual'):null,plan=mode==='queued'?adaptivePredictionBatch(queue,body.capacity):null;
 // Explicit small nonlegacy diagnostics batches remain possible. The old scheduled 4 is a legacy hint, not a throughput cap.
 const batchSize=mode==='queued'?Math.min(plan.batchSize,body.batchSize!==undefined&&!(body.trigger==='scheduled'&&body.batchSize===4)?body.batchSize:MAX_PREDICTION_BATCH):eligible.length;
 const previous=await loadJSON(env,ENRICHMENT_KEY+'latest-run.json');
 const runId=acquired?.runId||crypto.randomUUID(),lease=acquired||await runnerLease(env,runId,'acquire');if(lease.status!=='owned')return json({...lease,runner:predictionRunnerContract()});
 const recovered=lease.recoveredRunId?await checkedRun(env,lease.recoveredRunId):previous?.status==='running'?previous:null;
 if(recovered&&['running','interrupted'].includes(recovered.status)){recovered.status='interrupted';recovered.recoverable=true;recovered.reason='lease_expired';recovered.stopReason='lease_expired';recovered.completedAt=new Date().toISOString();recovered.recoveredByRunId=runId;await saveJSON(env,runKey(recovered.runId),recovered);await diagnosticCheckpoint(env,recovered);}

 const selected=mode==='queued'?queueBatchIds(queue,queueReadyIds(queue),batchSize).map(id=>eligible.find(f=>String(f.id)===id)).filter(Boolean):body.limit===undefined?eligible:eligible.slice(0,body.limit);
 if(mode==='queued'&&!selected.length){await runnerLease(env,runId,'release');const at=new Date().toISOString(),remaining=queue.priorityCount+queue.coldRemaining,reason=plan.reason==='quota'?'quota':remaining?'retry_backoff':null,stage=reason?'blocked':'noop';queue.lastCheckAt=at;queue.lastBatch={runId:null,trigger:body.trigger==='scheduled'?'scheduled':'manual',startedAt:at,finishedAt:at,stage,profileVersion:profile.version,batchSize:0,hotProcessed:0,coldProcessed:0,hotRemaining:queue.priorityCount,coldRemaining:queue.coldRemaining,checked:0,added:0,updated:0,failed:0,remaining,reason};await saveJSON(env,predictionQueueKey,queue);if(reason==='retry_backoff')await writeEvent(env,{id:'enrichment-blocked-'+Math.floor(Date.now()/3600000),type:'enrichment',at,queueSchemaVersion:3,...queue.lastBatch,...scheduledRunFields()});return json({status:stage,...queue.lastBatch,...scheduledRunFields()});}
 const states=await Promise.all(selected.map(f=>readFilmState(env,f.id))),baseline=Object.fromEntries(selected.map((f,i)=>[String(f.id),states[i].predictions?.current?.generatedAt||null])),freshness=await predictionFreshness(env,profile),pendingCount=mode==='queued'?queue.pending.length:states.filter((s,i)=>!freshness.state(s.predictions?.current,s.fingerprint,selected[i].genres)).length;

 const createdAt=new Date().toISOString(),run={runId,pipelineVersion:PREDICTION_PIPELINE_VERSION,status:'running',mode,trigger:body.trigger==='scheduled'?'scheduled':'manual',createdAt,diagnosticStartedAt:acquired?.diagnosticStartedAt||createdAt,leaseAcquiredAt:acquired?.heartbeatAt||createdAt,startResult:acquired?.startResult||(recovered?.recoverable?'recovered_stale_lease':'running'),lastActivityAt:createdAt,deadlineAt:null,lastHeartbeatAt:createdAt,batchCount:1,capacity:body.capacity||{},sourceProgrammeRunId:report.runId,tasteProfileVersion:profile.version,tasteProfileHash:profile.profileHash,fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,fingerprintPromptVersion:FINGERPRINT_PROMPT_VERSION,predictionPromptVersion:PREDICTION_PROMPT_VERSION,fingerprintRegistryDigest:freshness.registryDigest??(await fingerprintRegistryDigests()).registry,eligibleCount:eligible.length,batchSize:selected.length,adaptivePlan:plan,selectedIds:selected.map(f=>String(f.id)),selectionKind:Object.fromEntries(selected.map(f=>[String(f.id),mode==='queued'&&queue.priority[f.id]?.hot?'hot':'cold'])),baseline,failures:{},results:{}};
 await saveJSON(env,ENRICHMENT_KEY+'sources/'+run.runId+'.json',Object.fromEntries(selected.map(f=>[String(f.id),modelMetadata(f)])));await savePredictionRun(env,run);await runnerStarted(env,run,!!recovered&&recovered.recoveredByRunId===runId||!!previous&&['running','partial'].includes(previous.status)&&previous.tasteProfileHash===profile.profileHash,queue);return json({...runSummary(run),pendingCount,hotRemaining:queue?.priorityCount??null,coldRemaining:queue?.coldRemaining??null,...scheduledRunFields(),runner:predictionRunnerContract()});
}
function predictionRunnerContract(){return {pipelineVersion:5,continuous:true,itemFailures:{reportVia:'submit items[].failure.kind',allowedKinds:['parse_error','validation_error'],retryable:true,retryBaseMs:3600000,stopAfterConsecutive:5,validation:{preflight:'GET /api/enrichment/schema contract',reportedVia:'submit results[].validation {stage, reportedBy, issues[{path, code}]}',stages:['caller_reported','fingerprint_schema','fingerprint_missing','prediction_schema'],issueCodes:ISSUE_CODES}},maxBatchFilms:20,maxRunFilms:null,maxRunMinutes:null,leaseTtlMs:RUNNER_LEASE_TTL,heartbeat:'/api/enrichment/heartbeat',read:'/api/enrichment/runner',modelBatching:{enabled:false,readyFingerprintsPerCall:1},instructions:['Start returns already_running: exit immediately, do not adopt its runId.','Repeat next/submit continuously across adaptive batches until queue empty or real quota/API/storage failure. No time or total-film cap.','Keep profile and scoring rules unchanged; reuse valid fingerprints and predictions. Submit each film immediately.','Lease TTL is 15 minutes. Heartbeat before model calls and after checkpoints; renew concurrently every 10 minutes during long calls. Expired ownership is replaced atomically and start returns running in the same trigger.','Malformed/invalid per-film outputs: submit {filmId,failure:{kind:parse_error}} as valid JSON, then continue next/submit. Never complete for one item parse_error.','Before submit, check the fingerprint and prediction against the schema contract (required execution dimensions, enum values, moodLabels 2–4). A Worker schema rejection is still a retryable parse_error for that film and returns results[].validation.issues [{path, code}] naming the field; fix that field for the following films, do not resubmit the deferred one in this run.','Stop only on mustComplete/systemic quota/API/storage/lease failure; complete with stopReason. Five consecutive distinct item format failures trigger format_error_storm.','A formed response does not prove the client received it. Send or read X-Request-Id. On an external or systemic stop, complete may include fault {origin, failedStep, providerErrorCode, httpStatus, receivedRequestId}. Omit fault when the cause is unknown. A fault on queue_empty or another normal completion is rejected.']};}
function runSummary(r){return {runId:r.runId,processed:Object.values(r.results||{}).filter(x=>x!=='failed').length,batchCount:r.batchCount||1,lastHeartbeatAt:r.lastHeartbeatAt||null,hotRemaining:r.hotRemaining??null,coldRemaining:r.coldRemaining??null,stopReason:r.stopReason||null,sourceProgrammeRunId:r.sourceProgrammeRunId,tasteProfileVersion:r.tasteProfileVersion,tasteProfileHash:r.tasteProfileHash,fingerprintSchemaVersion:r.fingerprintSchemaVersion,predictionPromptVersion:r.predictionPromptVersion,eligibleCount:r.eligibleCount,selectedCount:r.selectedIds.length,batchSize:r.batchSize??r.selectedIds.length,adaptivePlan:r.adaptivePlan||null,deadlineAt:r.deadlineAt||null,status:r.status,trigger:r.trigger||'manual',startedAt:r.createdAt,finishedAt:r.completedAt||null,checked:Object.keys(r.results||{}).length,added:Object.values(r.results||{}).filter(x=>x==='created').length,updated:Object.values(r.results||{}).filter(x=>x==='recalculated').length,failed:Object.keys(r.failures||{}).length,hotProcessed:Object.entries(r.results||{}).filter(([id,status])=>['created','recalculated'].includes(status)&&r.selectionKind?.[id]==='hot').length,coldProcessed:Object.entries(r.results||{}).filter(([id,status])=>['created','recalculated'].includes(status)&&r.selectionKind?.[id]==='cold').length};}
async function checkedRun(env,id){if(!isText(id,100))return null;return loadJSON(env,runKey(id));}
// A run is bound to the fingerprint schema, both prompt versions and the registry it started with (ADR-0035 section 6);
// a deploy that changes any of them ends it, as a profile publication does. A run from before the prompt version was
// recorded is bound to version 1, the reading of every earlier fingerprint.
async function runContractChanged(run){
 const registry=(await fingerprintRegistryDigests()).registry;
 return run.fingerprintSchemaVersion!==FINGERPRINT_SCHEMA_VERSION||(run.fingerprintPromptVersion??1)!==FINGERPRINT_PROMPT_VERSION||run.predictionPromptVersion!==PREDICTION_PROMPT_VERSION||(run.fingerprintRegistryDigest??registry)!==registry;
}
const contractChangedResponse=()=>json({error:'Contract changed; start a new run',code:'contract_changed'},409);
async function enrichmentNext(env,body){
 const run=await checkedRun(env,body?.runId);if(!run)return json({error:'Unknown run'},404);if(run.status!=='running')return json({error:'Run already complete',stopReason:run.stopReason||null,mustComplete:!!run.reason},409);run.firstNextAt||=new Date().toISOString();await savePredictionRun(env,run);const requestSize=body.batchSize??run.batchSize??MAX_PREDICTION_BATCH;if(!Number.isInteger(requestSize)||requestSize<1||requestSize>20)return json({error:'Invalid batchSize'},400);
 const lease=await runnerLease(env,run.runId);if(lease.status!=='owned')return json(lease,409);run.lastHeartbeatAt=lease.heartbeatAt;
 if(run.systemicStopReason)return json({runId:run.runId,items:[],mustComplete:true,stopReason:run.systemicStopReason});
 if(body.capacity?.remainingPercent===0||body.capacity?.quotaAvailable===false)return json({runId:run.runId,items:[],mustComplete:true,stopReason:'quota'});
 const profile=await loadJSON(env,profileKey);if(profile?.profileHash!==run.tasteProfileHash)return json({error:'Profile changed; start a new run'},409);
 if(await runContractChanged(run))return contractChangedResponse();
 let source=await loadJSON(env,ENRICHMENT_KEY+'sources/'+run.runId+'.json')||{},states=await Promise.all(run.selectedIds.map(id=>readFilmState(env,id))),index=await loadJSON(env,ENRICHMENT_KEY+'view-index.json')||{},repairs=[],runRepair=false;
 const freshness=await predictionFreshness(env,profile),fresh=(id,state)=>freshness.state(state.predictions?.current,state.fingerprint,source[id]?.genres);
 // A fingerprint newer than the code's versions (a rolled-back release) is restored from its stored generation record when
 // one is current for the target: the pointer moves back, no model run (ADR-0035 section 7).
 for(let i=0;i<run.selectedIds.length;i++){const id=run.selectedIds[i],s=states[i];if(freshness.fingerprintVerdict(s.fingerprint,source[id]?.genres)?.reason!=='fingerprint_ahead')continue;const restored=await restoreFingerprint(env,id,source[id]?.genres);if(restored){s.fingerprint=restored;run.restored=[...(run.restored||[]),id];runRepair=true;}}
 for(let i=0;i<run.selectedIds.length;i++){const id=run.selectedIds[i],s=states[i],p=s.predictions?.current;// A fresh prediction whose index entry lacks its record or its impact facet is
 // repaired, so the queue and the view (which read the index) agree with this step.
 if(fresh(id,s)&&(index[id]?.prediction?.generatedAt!==p.generatedAt||freshness.needsGenres&&index[id]?.impactFeatures?.fingerprintHash!==s.fingerprint?.fingerprintHash))repairs.push({id,prediction:p,fingerprintHash:s.fingerprint.fingerprintHash,fingerprint:fingerprintFacet(s.fingerprint,true),impactFeatures:fingerprintImpactFacet(s.fingerprint)});}
 for(let i=0;i<run.selectedIds.length;i++){const id=run.selectedIds[i],s=states[i],p=s.predictions?.current;if(run.failures[id]&&fresh(id,s)){delete run.failures[id];run.results[id]=p.generatedAt!==run.baseline[id]?(run.baseline[id]?'recalculated':'created'):'already_current';runRepair=true;}}
 if(repairs.length)await mergeStoredJSON(env,ENRICHMENT_KEY+'view-index.json',{},current=>{for(const item of repairs)current[item.id]={...(current[item.id]||{}),prediction:item.prediction,fingerprintHash:item.fingerprintHash,fingerprint:item.fingerprint,impactFeatures:item.impactFeatures};return current;});if(runRepair)await savePredictionRun(env,run);
 if(run.mode==='queued'){
  const report=await loadJSON(env,'programme.json'),queue=await refreshPredictionQueue(env,report,'next_priority'),catalog=await loadJSON(env,'epg/discovered-films.json'),films=new Map(allEnrichmentFilms(report,catalog).map(f=>[String(f.id),f])),completed=run.selectedIds.filter((id,i)=>fresh(id,states[i])||run.results?.[id]);
  let slots=Math.max(0,run.batchSize-completed.filter(id=>(run.batchIds||run.selectedIds).includes(id)).length),newBatch=false;
  if(!slots){const plan=adaptivePredictionBatch(queue,body.capacity||run.capacity);run.adaptivePlan=plan;run.batchSize=plan.batchSize;slots=plan.batchSize;run.batchIds=[];newBatch=true;}
  const ready=queueBatchIds(queue,queueReadyIds(queue).filter(id=>!run.failures[id]),slots);run.batchIds=[...new Set([...(run.batchIds||completed),...ready])];const selected=[...new Set([...(newBatch?[]:completed),...ready])];if(newBatch&&ready.length)run.batchCount++;
  run.hotRemaining=queue.priorityCount;run.coldRemaining=queue.coldRemaining;await runnerProgress(env,run,queue);await savePredictionRun(env,run);
  if(!ready.length){const reason=run.adaptivePlan?.reason==='quota'?'quota':queue.priorityCount+queue.coldRemaining?'eligible_queue_empty':'queue_empty';return json({runId:run.runId,items:[],mustComplete:true,stopReason:reason,hotRemaining:queue.priorityCount,coldRemaining:queue.coldRemaining});}
  if(selected.join('|')!==run.selectedIds.join('|')){
   run.selectedIds=selected;for(const id of ready){if(!source[id]){const film=films.get(id);if(!film)continue;source[id]=modelMetadata(film);const s=await readFilmState(env,id);run.baseline[id]=s.predictions?.current?.generatedAt||null;}run.selectionKind[id]=queue.priority[id]?.hot?'hot':'cold';}
   await saveJSON(env,ENRICHMENT_KEY+'sources/'+run.runId+'.json',source);await savePredictionRun(env,run);states=await Promise.all(selected.map(id=>readFilmState(env,id)));
  }
 }
 const items=[];let pendingCount=0;
 for(let i=0;i<run.selectedIds.length;i++){const id=run.selectedIds[i],s=states[i];if(fresh(id,s)||run.failures[id])continue;pendingCount++;if(items.length>=requestSize)continue;const film=source[id];if(!film)continue;const requiredWork=freshness.fingerprintUsable(s.fingerprint,source[id]?.genres)?'prediction_only':'fingerprint_and_prediction',item={filmId:id,requiredWork};if(requiredWork==='prediction_only')item.fingerprint=s.fingerprint;else item.metadata=film;items.push(item);}
 return json({runId:run.runId,profile:profile.profile,profileVersion:profile.version,profileHash:profile.profileHash,fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,fingerprintPromptVersion:FINGERPRINT_PROMPT_VERSION,predictionPromptVersion:PREDICTION_PROMPT_VERSION,items,pendingCount,batchSize:run.batchSize,deadlineAt:run.deadlineAt||null,modelBatching:predictionRunnerContract().modelBatching});
}
async function enrichmentSubmit(env,body){
 const run=await checkedRun(env,body?.runId);if(!run)return json({error:'Unknown run'},404);if(run.status!=='running')return json({error:'Run already complete',stopReason:run.stopReason||null,mustComplete:!!run.reason},409);if(!Array.isArray(body.items)||!body.items.length||body.items.length>10)return json({error:'Expected 1–10 items'},400);
 const lease=await runnerLease(env,run.runId);if(lease.status!=='owned')return json(lease,409);run.lastHeartbeatAt=lease.heartbeatAt;
 if(run.systemicStopReason)return json({...runSummary(run),mustComplete:true,stopReason:run.systemicStopReason});
 const profile=await loadJSON(env,profileKey);if(profile?.profileHash!==run.tasteProfileHash)return json({error:'Profile changed; start a new run'},409);
 if(await runContractChanged(run))return contractChangedResponse();
 const freshness=await predictionFreshness(env,profile),source=freshness.needsGenres?await loadJSON(env,ENRICHMENT_KEY+'sources/'+run.runId+'.json')||{}:{};
 const results=[];
 for(const item of body.items){const id=String(item?.filmId||'');if(!run.selectedIds.includes(id)){results.push({filmId:id,error:'Film not selected',failureScope:'request'});continue;}
  // Re-delivering the same failed outcome is idempotent and cannot manufacture an error storm.
  if(run.failures[id]?.scope==='item'){const stored=run.failures[id];results.push({filmId:id,status:'retryable_failure',error:stored.kind,failureScope:'item',retryable:true,retryAt:stored.retryAt,...(stored.validation?{validation:stored.validation}:{})});continue;}
  // AIR-152: a schema rejection names the field and the violation from the closed contract vocabulary
  // (see ruleIssues); the thrown message, the payload and the model output are never copied out.
  let failureStage='storage_error',validationStage=null,reportedBy=null,issues=null;try{const state=await readFilmState(env,id);let fingerprint=state.fingerprint;
   if(item.failure&&!freshness.state(state.predictions?.current,fingerprint,source[id]?.genres)){failureStage='parse_error';validationStage='caller_reported';reportedBy='caller';issues=[];throw new Error('Reported malformed model response');}
   const usable=f=>freshness.fingerprintUsable(f,source[id]?.genres);
   if(item.fingerprint&&!usable(fingerprint)){const found=fingerprintIssues(item.fingerprint);if(found.length){failureStage='parse_error';validationStage='fingerprint_schema';reportedBy='worker';issues=found;throw new Error('Invalid fingerprint');}fingerprint=await writeFingerprint(env,id,item.fingerprint,fingerprint,'generated');}
   if(!usable(fingerprint)){failureStage='parse_error';validationStage='fingerprint_missing';reportedBy='worker';issues=[{path:'fingerprint',code:'required'}];throw new Error('Current fingerprint required');}
   if(freshness.state(state.predictions?.current,fingerprint,source[id]?.genres)){await updateViewIndex(env,id,{prediction:state.predictions.current,fingerprintHash:fingerprint.fingerprintHash,fingerprint:fingerprintFacet(fingerprint,true),impactFeatures:fingerprintImpactFacet(fingerprint)});run.results[id] ||= 'already_current';delete run.failures[id];results.push({filmId:id,status:'already_current'});}
   // Lineage of a new prediction (AIR-12): the fingerprint's prompt version completes its identity, runId and trigger name the run
   // that produced it. Records written before carry none of the three; readers treat them as unknown, never as the current run.
   else{const found=predictionIssues(item.prediction);if(found.length){failureStage='parse_error';validationStage='prediction_schema';reportedBy='worker';issues=found;throw new Error('Invalid prediction');}const at=new Date().toISOString(),generated={...item.prediction,filmId:id,generatedAt:at,tasteProfileVersion:profile.version,tasteProfileHash:profile.profileHash,fingerprintHash:fingerprint.fingerprintHash,fingerprintSchemaVersion:fingerprint.fingerprintSchemaVersion,fingerprintPromptVersion:fingerprint.fingerprintPromptVersion??1,predictionPromptVersion:PREDICTION_PROMPT_VERSION,runId:run.runId,trigger:run.trigger==='scheduled'?'scheduled':'manual'},old=state.predictions?.current,history=[...(state.predictions?.history||[])];
    // The version object is written first (write-once, keyed by checksum); a crash before the bundle write leaves an unreferenced object and an unchanged bundle, never a pointer to a missing object.
    const prediction={...generated,...(await writePredictionVersion(env,id,generated))};
    if(old)history.push({...old,replacedAt:at});await saveJSON(env,filmKey(id)+'predictions.json',{current:prediction,history});await updateViewIndex(env,id,{prediction,fingerprintHash:fingerprint.fingerprintHash,fingerprint:fingerprintFacet(fingerprint,true),impactFeatures:fingerprintImpactFacet(fingerprint)});delete run.failures[id];run.results[id]=old?'recalculated':'created';results.push({filmId:id,status:run.results[id]});}
   if(['created','recalculated'].includes(run.results[id]))run.firstSubmitAt||=new Date().toISOString();run.formatFailureStreak=0;
  }catch(e){const at=new Date().toISOString(),retryable=failureStage==='parse_error',previous=await loadJSON(env,predictionQueueKey),attempts=(previous?.retries?.[id]?.attempts||0)+1,retryAt=Date.now()+Math.min(6*3600000,3600000*2**(attempts-1));
   const validation=validationStage?{stage:validationStage,reportedBy,issues}:null;
   run.failures[id]={kind:failureStage,scope:retryable?'item':'run',retryable:true,failedAt:at,retryAt,attempts,...(validation?{validation}:{})};run.results[id]='failed';results.push({filmId:id,status:retryable?'retryable_failure':'failed',error:failureStage,failureScope:retryable?'item':'run',retryable:true,retryAt,...(validation?{validation}:{})});
   if(retryable){run.formatFailureStreak=(run.formatFailureStreak||0)+1;if(run.formatFailureStreak>=5)run.systemicStopReason='format_error_storm';}else run.systemicStopReason=failureStage;
   if(validationStage){const stages=[...(run.itemValidation?.stages||[]),{stage:validationStage,reportedBy}].slice(-8);run.itemValidation={consecutive:run.formatFailureStreak||0,stages};}
  }
  run.lastActivityAt=new Date().toISOString();const renewed=await runnerLease(env,run.runId);if(renewed.status!=='owned')return json(renewed,409);run.lastHeartbeatAt=renewed.heartbeatAt;await savePredictionRun(env,run);
  // Retry state is persisted immediately, not postponed until the eventual run completion.
  if(run.failures[id]){const queue=await loadJSON(env,predictionQueueKey);if(queue){queue.retries||={};queue.retries[id]={...run.failures[id],lastRunId:run.runId};await saveJSON(env,predictionQueueKey,queue);}}
  if(run.systemicStopReason)break;
 }
 let queue=null;if(run.mode==='queued')queue=await refreshPredictionQueue(env,await loadJSON(env,'programme.json'),'batch_progress');await runnerProgress(env,run,queue);
 return json({...runSummary(run),results,mustComplete:!!run.systemicStopReason,stopReason:run.systemicStopReason||null,remaining:queue?.pending.length??null,hotRemaining:queue?.priorityCount??null,coldRemaining:queue?.coldRemaining??null,...scheduledRunFields()});
}
async function enrichmentComplete(env,body){
 const run=await checkedRun(env,body?.runId);if(!run)return json({error:'Unknown run'},404);
 if(run.status==='complete'||run.status==='partial'){if(run.event)await writeEvent(env,run.event);else await writeEvent(env,{id:'enrichment-'+run.runId,type:'enrichment',at:run.completedAt,...run.counts});await runnerLease(env,run.runId,'release');return json({runId:run.runId,status:run.status,counts:run.counts,...(run.event||{})});}
 const fault=readCallerFault(body);if(fault.rejected)return json({error:'Invalid fault'},400);
 const faultReason=typeof body.reason==='string'&&!NORMAL_COMPLETE.includes(body.reason)?systemicReason(body.reason):null;
 if(fault.value&&!FAULT_REASONS.includes(faultReason))return json({error:'Fault requires an external stop reason'},400);
 const attributed=externalAttribution(faultReason,fault.value);if(attributed)run.callerFault=attributed;
 const lease=await runnerLease(env,run.runId);if(lease.status!=='owned')return json(lease,409);run.lastHeartbeatAt=lease.heartbeatAt;
 if(body.reason&&!NORMAL_COMPLETE.includes(body.reason))return json(await recordRunStop(env,run.runId,systemicReason(body.reason),{callerFault:run.callerFault||null}));
 const profile=await loadJSON(env,profileKey);if(profile?.profileHash!==run.tasteProfileHash&&!body.reason)return json({error:'Profile changed; start a new run'},409);
 if(!body.reason&&await runContractChanged(run))return contractChangedResponse();
 if(run.mode==='queued'&&(!body.reason||['queue_empty','eligible_queue_empty','parse_error'].includes(body.reason))&&!run.systemicStopReason){const queue=await refreshPredictionQueue(env,await loadJSON(env,'programme.json'),'completion_check');if(queueReadyIds(queue).some(id=>!run.failures[id]))return json({error:'Queue not empty; continue next',runId:run.runId,hotRemaining:queue.priorityCount,coldRemaining:queue.coldRemaining},409);}
 const states=await Promise.all(run.selectedIds.map(id=>readFilmState(env,id)));let created=0,recalculated=0,pending=0;
 const freshness=await predictionFreshness(env,profile),source=freshness.needsGenres?await loadJSON(env,ENRICHMENT_KEY+'sources/'+run.runId+'.json')||{}:{};
 for(let i=0;i<states.length;i++){const s=states[i],p=s.predictions?.current,id=run.selectedIds[i];if(p?.generatedAt&&p.generatedAt!==run.baseline[id]&&p.tasteProfileHash===run.tasteProfileHash&&p.predictionPromptVersion===run.predictionPromptVersion){run.baseline[id]?recalculated++:created++;if(!['created','recalculated'].includes(run.results?.[id]))run.results[id]=run.baseline[id]?'recalculated':'created';}else if(!run.failures[id]&&!freshness.state(p,s.fingerprint,source[id]?.genres))pending++;}
 created=Object.values(run.results).filter(x=>x==='created').length;recalculated=Object.values(run.results).filter(x=>x==='recalculated').length;const failed=Object.keys(run.failures).length;run.counts={created,recalculated,failed,pending};run.reason=['queue_empty','eligible_queue_empty','parse_error'].includes(body.reason)?null:safePredictionReason(body.reason||run.interruption);run.reason=run.systemicStopReason||run.reason;run.stopReason=run.reason||(failed?'eligible_queue_empty':pending?'external_termination':'queue_empty');run.status=pending||run.reason?'partial':'complete';run.completedAt=new Date().toISOString();
 const summary=runSummary(run);let hotRemaining=null,coldRemaining=null,remaining=pending;
 if(run.mode==='queued'){
  const queue=await refreshPredictionQueue(env,await loadJSON(env,'programme.json'),'batch_complete');remaining=queue?.pending.length??pending;hotRemaining=queue?.priorityCount??null;coldRemaining=queue?.coldRemaining??null;
  // A normal completion is "drained" only when the refreshed queue has no outstanding film; otherwise work remains that
  // this run could not take (deferred by retry or waiting behind hot). Run completion and a drained queue stay separate.
  if(queue&&!run.reason&&!pending)run.stopReason=queue.priorityCount+queue.coldRemaining?'eligible_queue_empty':'queue_empty';
  if(queue){for(const id of Object.keys(run.failures)){if(queue.retries[id]?.lastRunId===run.runId)continue;const failure=run.failures[id],tries=(queue.retries[id]?.attempts||0)+1;queue.retries[id]={attempts:tries,retryAt:failure.retryAt||Date.now()+Math.min(6*3600000,3600000*2**(tries-1)),retryable:true,scope:failure.scope||'run',kind:failure.kind||failure,lastRunId:run.runId};}
   queue.lastBatch={runId:run.runId,trigger:run.trigger,startedAt:run.createdAt,finishedAt:run.completedAt,stage:run.status,profileVersion:run.tasteProfileVersion,batchSize:run.batchSize,hotProcessed:summary.hotProcessed,coldProcessed:summary.coldProcessed,checked:summary.checked,added:created,updated:recalculated,failed,remaining,hotRemaining,coldRemaining,reason:run.reason,perFilmMs:created+recalculated?(Date.parse(run.completedAt)-Date.parse(run.createdAt))/(created+recalculated):null};queue.lastCheckAt=run.completedAt;queue.metrics.hotProcessedTotal+=summary.hotProcessed;await saveJSON(env,predictionQueueKey,queue);}
 }
 const snapshot=await predictionEventSnapshot(env,run.mode==='queued'?await loadJSON(env,predictionQueueKey):null,run.batchSize),delta=predictionEventDelta(run,summary,snapshot),event={id:'enrichment-'+run.runId,type:'enrichment',at:run.completedAt,...run.counts,checked:summary.checked,added:created,updated:recalculated,batchSize:run.batchSize,hotProcessed:summary.hotProcessed,coldProcessed:summary.coldProcessed,remaining,hotRemaining,coldRemaining,queueSchemaVersion:6,batchCount:run.batchCount,batchesProcessed:predictionBatchesProcessed(run),delta,snapshot,lastHeartbeatAt:run.lastHeartbeatAt,stopReason:run.stopReason,trigger:run.trigger,stage:run.status,reason:run.reason,...scheduledRunFields()};run.event=event;await savePredictionRun(env,run);await writeEvent(env,event);await runnerLease(env,run.runId,'release');return json({runId:run.runId,status:run.status,counts:run.counts,...event});
}
async function enrichmentStatus(env){const recent=(await diagnosticHistory(env,20)).runs;const [profile,run,report,queue,catalog,discovery,lease]=await Promise.all([loadJSON(env,profileKey),loadJSON(env,ENRICHMENT_KEY+'latest-run.json'),loadJSON(env,'programme.json'),queueStatus(env),loadJSON(env,'epg/discovered-films.json'),loadJSON(env,'epg/discovery-status.json'),loadJSON(env,RUNNER_LEASE_KEY)]);const films=report?allEnrichmentFilms(report,catalog):[];const summary=run?runSummary(run):null,state=run?.status==='running'?(lease?.runId===run.runId&&lease.expiresAt>Date.now()?'running':'blocked'):run?.status==='partial'?'blocked':run?.status==='complete'?'completed':'idle',live={state,runId:run?.runId||null,startedAt:run?.createdAt||null,lastHeartbeatAt:state==='running'&&lease&&lease.runId===run?.runId?lease.heartbeatAt:run?.lastHeartbeatAt||null,added:summary?.added||0,failed:summary?.failed||0,hotRemaining:queue?.hotRemaining??null,coldRemaining:queue?.coldRemaining??null,currentBatchSize:state==='running'?run.batchSize??null:null};return {...live,diagnostics:compactDiagnostics(recent.find(row=>row.runId===run?.runId)||recent[0]||null),live,currentRun:state==='running'?live:null,recentRuns:recent.filter(r=>r.state!=='running').slice(0,10),profileVersion:profile?.version||null,fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,fingerprintPromptVersion:FINGERPRINT_PROMPT_VERSION,predictionPromptVersion:PREDICTION_PROMPT_VERSION,compatibility:{profileMode:PREDICTION_PROFILE_MODE,fingerprintMode:PREDICTION_FINGERPRINT_MODE},lastRun:run?{...runSummary(run),counts:run.counts||null,failures:run.failures,reason:run.reason||null,completedAt:run.completedAt||null}:null,selectedCount:films.length,pendingCount:queue?.pendingCount??null,discovery:discovery||null,queue};}
async function enrichmentView(env){const [profile,index]=await Promise.all([loadJSON(env,profileKey),ensureInitialRatings(env)]),freshness=await predictionFreshness(env,profile);
 // Genres feed only the selective rules, so the programme and catalog are read only when one of them is on.
 const films=freshness.needsGenres?await (async()=>{const pinned=await pinEpg(env),[report,catalog]=await Promise.all([loadJSON(pinned,'programme.json'),loadJSON(pinned,'epg/discovered-films.json')]);return new Map(allEnrichmentFilms(report||{films:[]},catalog).map(f=>[String(f.id),f]));})():null;return {moodVocabulary:{version:MOOD_MAPPING_VERSION,labels:MOOD_LABELS},profile:profile?{version:profile.version,updatedAt:profile.updatedAt}:null,compatibility:{profileMode:freshness.mode,fingerprintMode:freshness.fingerprintMode,...fingerprintTarget()},films:Object.fromEntries(Object.entries(index||{}).map(([id,item])=>{const p=item.prediction,f=item.fingerprint,facet=canonicalMoodFacet(f,p);return [id,{moodIds:facet.moodIds,fingerprint:f&&f.fingerprintHash===item.fingerprintHash?{plotMechanics:f.plotMechanics||[],moodIds:facet.moodIds,execution:executionFacet(f.execution)}:null,prediction:p?{predictedRating:p.predictedRating,probability4Plus:p.probability4Plus,confidence:p.confidence,matchSignals:p.matchSignals,mainRisk:p.mainRisk,moodIds:facet.moodIds,stale:!freshness.indexed(item,films?.get(id))}:null,actualRating:item.actualRating??null}];}))};}

async function backfillFingerprintView(env,body){const [index,report,catalog]=await Promise.all([ensureInitialRatings(env),loadJSON(env,'programme.json'),loadJSON(env,'epg/discovered-films.json')]),ids=[...new Set([...Object.keys(index),...allEnrichmentFilms(report||{films:[]},catalog).map(f=>String(f.id))])].sort(),cursor=String(body.cursor||'');if(body.limit!==undefined&&(!Number.isInteger(body.limit)||body.limit<1||body.limit>100))return json({error:'Invalid limit'},400);const selected=ids.filter(id=>id>cursor).slice(0,body.limit||80),fingerprints=await Promise.all(selected.map(id=>loadJSON(env,filmKey(id)+'fingerprint.json')));let added=0,updated=0;const patches=[];for(let i=0;i<selected.length;i++){const id=selected[i],facet=fingerprintFacet(fingerprints[i]),impact=fingerprintImpactFacet(fingerprints[i]);const previousFacet=index[id]?.fingerprint;if(!facet||previousFacet?.fingerprintHash===facet.fingerprintHash&&Object.hasOwn(previousFacet,'execution')&&index[id]?.impactFeatures?.fingerprintHash===facet.fingerprintHash)continue;patches.push({id,facet,impact});index[id]?.fingerprint?updated++:added++;}if(patches.length)await mergeStoredJSON(env,ENRICHMENT_KEY+'view-index.json',{},current=>{for(const patch of patches)current[patch.id]={...(current[patch.id]||{}),fingerprintHash:patch.facet.fingerprintHash,fingerprint:patch.facet,impactFeatures:patch.impact};return current;});return json({checked:selected.length,added,updated,nextCursor:selected.length&&ids.some(id=>id>selected.at(-1))?selected.at(-1):null});}
const predictionBenchmarkKey=id=>ENRICHMENT_KEY+'benchmarks/'+encodeURIComponent(id)+'.json';
async function predictionBenchmarkStart(env){
 const [profile,index,report,catalog]=await Promise.all([loadJSON(env,profileKey),loadJSON(env,ENRICHMENT_KEY+'view-index.json'),loadJSON(env,'programme.json'),loadJSON(env,'epg/discovered-films.json')]);if(!profile)return json({error:'No profile'},409);
 const films=new Map(allEnrichmentFilms(report||{films:[]},catalog).map(f=>[String(f.id),f])),candidates=Object.entries(index||{}).filter(([,item])=>indexedPredictionCurrent(item,profile)).sort(([a],[b])=>a.localeCompare(b,'en')).slice(0,80),sample=[],references={};
 for(const [id] of candidates){const state=await readFilmState(env,id);if(!fingerprintCurrent(state.fingerprint)||!predictionCurrent(state.predictions?.current,profile,state.fingerprint))continue;sample.push({filmId:id,fingerprint:state.fingerprint,...(films.has(id)?{metadata:modelMetadata(films.get(id))}:{})});references[id]=state.predictions.current;if(sample.length===20)break;}
 if(sample.length<20)return json({error:'Need 20 existing current fingerprints/predictions for the isolated benchmark'},409);
 const benchmark={benchmarkId:crypto.randomUUID(),createdAt:new Date().toISOString(),profileVersion:profile.version,profileHash:profile.profileHash,profile:profile.profile,fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,predictionPromptVersion:PREDICTION_PROMPT_VERSION,sample,references,trials:[],productionBatchingEnabled:false};await saveJSON(env,predictionBenchmarkKey(benchmark.benchmarkId),benchmark);
 return json({benchmarkId:benchmark.benchmarkId,profile:benchmark.profile,profileVersion:benchmark.profileVersion,profileHash:benchmark.profileHash,items:sample,sizes:[4,8,12,20],rules:['Shadow benchmark only: never send trial outputs to enrichment/submit.','For each size, use the identical full taste profile/scoring instructions and first size saved fingerprints. Return a JSON array of {filmId,prediction}; no regeneration of fingerprints.','Record real model input/output tokens and elapsedMs if available. Missing telemetry remains null, never estimated as measured usage.','Existing predictions are held out as comparability references, not real outcome truth. Qualitative matchSignals/mainRisk review is required.']});
}
async function predictionBenchmarkTrial(env,body){
 const benchmark=await loadJSON(env,predictionBenchmarkKey(body.benchmarkId));if(!benchmark)return json({error:'Unknown benchmark'},404);
 if(![4,8,12,20].includes(body.size)||!Array.isArray(body.items)||body.items.length>20||!Number.isFinite(body.elapsedMs)||body.elapsedMs<0)return json({error:'Invalid benchmark trial'},400);
 const expected=benchmark.sample.slice(0,body.size).map(f=>f.filmId),seen=new Set(),parsed=[],failures=[];
 for(const item of body.items){const id=String(item?.filmId||''),error=!expected.includes(id)?'Unexpected film':seen.has(id)?'Duplicate film':validatePrediction(item.prediction);seen.add(id);if(error){failures.push({filmId:id,error});continue;}parsed.push({filmId:id,prediction:item.prediction});}
 for(const id of expected)if(!seen.has(id))failures.push({filmId:id,error:'Missing film'});
 const n=parsed.length,ratingDelta=n?parsed.reduce((sum,item)=>sum+Math.abs(item.prediction.predictedRating-benchmark.references[item.filmId].predictedRating),0)/n:null,probabilityDelta=n?parsed.reduce((sum,item)=>sum+Math.abs(item.prediction.probability4Plus-benchmark.references[item.filmId].probability4Plus),0)/n:null;
 const usage=isObject(body.usage)&&Number.isInteger(body.usage.inputTokens)&&body.usage.inputTokens>=0&&Number.isInteger(body.usage.outputTokens)&&body.usage.outputTokens>=0?{inputTokens:body.usage.inputTokens,outputTokens:body.usage.outputTokens}:null;
 const trial={size:body.size,at:new Date().toISOString(),elapsedMs:body.elapsedMs,usage,usageSource:usage?'caller_reported_model_telemetry':'unavailable',parsed:n,failed:failures.length,failures,meanRatingDelta:ratingDelta,meanProbabilityDelta:probabilityDelta,outputs:parsed,qualitativeReview:isObject(body.qualitativeReview)?{matchSignalsComparable:body.qualitativeReview.matchSignalsComparable===true,mainRiskComparable:body.qualitativeReview.mainRiskComparable===true}:null};benchmark.trials.push(trial);await saveJSON(env,predictionBenchmarkKey(benchmark.benchmarkId),benchmark);
 // Storing a benchmark cannot turn on multi-film production calls. Approval needs real comparable trials and review.
 return json({benchmarkId:benchmark.benchmarkId,trial,productionBatchingEnabled:false});
}
const RATINGS_STATUS_KEY=ENRICHMENT_KEY+'ratings/status.json';
const RATINGS_POINTER_KEY=ENRICHMENT_KEY+'ratings/published.json';
const RATINGS_PENDING_KEY=ENRICHMENT_KEY+'ratings/pending.json';
const ratingsGenerationKey=id=>ENRICHMENT_KEY+'ratings/generations/'+encodeURIComponent(id)+'.json';
// The owner-triggered ratings-only refresh is retired (ADR 0040): the route answers 410 Gone and nothing reads RATINGS_REFRESH.
// Stored ratings objects (status, published pointer, pending, generations) are kept and stay readable.
// Every committed prediction is written as an immutable version object; the bundle stays the runtime record. The former
// PREDICTION_VERSION_OBJECTS switch is retired (ADR 0045) and a stale binding is inert.
// Immutable fingerprint storage (ADR-0035 section 2). The content body is one object per distinct content, keyed by its
// hash; the generation record is one object per (hash, schema version, prompt version) and holds the provenance; both are
// create-only and never rewritten. fingerprint.json stays the full current record every reader already understands, plus
// the prompt version, how it was produced and the identity of the record it replaced. The body and record objects are
// written for every accepted fingerprint: the former FINGERPRINT_VERSION_OBJECTS switch is retired (ADR 0046) and a stale
// binding is inert.
const fingerprintBodyKey=(id,hash)=>filmKey(id)+'fingerprints/'+hash+'.json';
const fingerprintGenerationPrefix=id=>filmKey(id)+'fingerprint-generations/';
const fingerprintGenerationKey=(id,record)=>fingerprintGenerationPrefix(id)+record.fingerprintHash+'-s'+record.fingerprintSchemaVersion+'-p'+record.fingerprintPromptVersion+'.json';
const fingerprintIdentity=f=>f?{fingerprintHash:f.fingerprintHash,fingerprintSchemaVersion:f.fingerprintSchemaVersion,fingerprintPromptVersion:f.fingerprintPromptVersion??1}:null;
const FINGERPRINT_PRODUCED=['generated','partial','restored'];
const FINGERPRINT_RECORD_KEYS=['filmId','fingerprintHash','fingerprintSchemaVersion','fingerprintPromptVersion','generatedAt','produced','fields','previous'];
// Writes create-only and returns 'created', or 'existing' when the stored object is acceptable; anything else is a storage
// conflict and the submit of that film fails before the pointer moves. A body is content-addressed, so only the same bytes
// are acceptable. A record already under its own identity may differ only in what was first written (generation time,
// produced, fields, previous); it must parse, name the same film, hash and versions, carry valid provenance and link to a
// stored body. A corrupted, partial or foreign object never counts as the record.
async function putCreateOnly(env,key,value,accept=stored=>stored===JSON.stringify(value)){
 const text=JSON.stringify(value);
 if(await env.BUCKET.put(key,text,{httpMetadata:{contentType:'application/json'},onlyIf:{etagDoesNotMatch:'*'}})!==null)return 'created';
 const existing=await env.BUCKET.get(key),stored=existing?await existing.text():null;
 if(stored===text||await accept(stored))return 'existing';
 throw new Error('Immutable fingerprint object conflicts');
}
async function generationRecordAcceptable(env,stored,record){
 let existing;try{existing=JSON.parse(stored);}catch{return false;}
 if(!isObject(existing)||Object.keys(existing).some(key=>!FINGERPRINT_RECORD_KEYS.includes(key)))return false;
 if(existing.filmId!==record.filmId||existing.fingerprintHash!==record.fingerprintHash||existing.fingerprintSchemaVersion!==record.fingerprintSchemaVersion||existing.fingerprintPromptVersion!==record.fingerprintPromptVersion)return false;
 if(typeof existing.generatedAt!=='string'||!Number.isFinite(Date.parse(existing.generatedAt))||!FINGERPRINT_PRODUCED.includes(existing.produced))return false;
 if(existing.fields!==undefined&&!(Array.isArray(existing.fields)&&existing.fields.every(field=>typeof field==='string')))return false;
 if(existing.previous!==null&&!(isObject(existing.previous)&&typeof existing.previous.fingerprintHash==='string'&&Number.isInteger(existing.previous.fingerprintSchemaVersion)&&Number.isInteger(existing.previous.fingerprintPromptVersion)))return false;
 const body=await loadJSON(env,fingerprintBodyKey(record.filmId,record.fingerprintHash));
 return !!body&&body.fingerprintHash===record.fingerprintHash;
}
// Writes the accepted content as the film's current fingerprint and returns the stored record. `produced` is 'generated',
// 'partial' (with `fields`) or 'restored'; `previous` is the record being replaced.
async function writeFingerprint(env,id,content,previous,produced,fields,promptVersion=FINGERPRINT_PROMPT_VERSION){
 const at=new Date().toISOString(),body={...content,filmId:id};body.fingerprintHash=await contentHash({...content,filmId:id});
 const value={...body,generatedAt:at,invalidatedAt:null,fingerprintPromptVersion:promptVersion,produced,...(fields?{fields}:{}),previous:fingerprintIdentity(previous)};
 await putCreateOnly(env,fingerprintBodyKey(id,body.fingerprintHash),body);
 const record={filmId:id,...fingerprintIdentity(value),generatedAt:at,produced,...(fields?{fields}:{}),previous:value.previous};
 await putCreateOnly(env,fingerprintGenerationKey(id,record),record,stored=>generationRecordAcceptable(env,stored,record));
 await saveJSON(env,filmKey(id)+'fingerprint.json',value);
 await updateViewIndex(env,id,{fingerprintHash:value.fingerprintHash,fingerprint:fingerprintFacet(value),impactFeatures:fingerprintImpactFacet(value)});
 return value;
}
// The stored generation records of a film with their bodies, newest first; empty for a film whose fingerprints predate the writer. The whole prefix is
// read page by page up to FINGERPRINT_GENERATION_SCAN_LIMIT records; a longer history is a storage error, never "no candidate".
const FINGERPRINT_GENERATION_SCAN_LIMIT=1000;
async function fingerprintGenerations(env,id){
 const prefix=fingerprintGenerationPrefix(id),keys=[];let cursor;
 do{const page=await env.BUCKET.list({prefix,limit:100,...(cursor?{cursor}:{})});for(const object of page.objects||[])keys.push(object.key);if(keys.length>FINGERPRINT_GENERATION_SCAN_LIMIT)throw new Error('Fingerprint history exceeds the scan limit');cursor=page.truncated?page.cursor:null;}while(cursor);
 const records=[];
 for(const key of keys){const record=await loadJSON(env,key);if(!isObject(record)||typeof record.fingerprintHash!=='string')continue;const body=await loadJSON(env,fingerprintBodyKey(id,record.fingerprintHash));if(body&&body.fingerprintHash===record.fingerprintHash)records.push({...body,...record});}
 return records.sort((a,b)=>String(b.generatedAt).localeCompare(String(a.generatedAt)));
}
// Moves the pointer back to a stored generation record that is exact for the code's versions (ADR-0035 section 7), or
// returns null when none exists; the model is never called here.
async function restoreFingerprint(env,id,genres){
 const current=await loadJSON(env,filmKey(id)+'fingerprint.json'),registry=await fingerprintRegistryDigests();
 const candidate=fingerprintRestoreCandidate(await fingerprintGenerations(env,id),{genres},FINGERPRINT_TRANSITIONS,fingerprintTarget(),fingerprintEvaluatorOptions(registry.lookup));
 if(!candidate)return null;
 // The content keeps its schema version (part of the hashed content); the provenance fields are the record's own.
 const {filmId:_id,fingerprintHash:_h,fingerprintPromptVersion:_p,generatedAt:_g,produced:_r,fields:_f,previous:_v,...content}=candidate;
 return writeFingerprint(env,id,content,current,'restored',undefined,candidate.fingerprintPromptVersion);
}
// Write-once: the key carries the checksum, so an existing object must hold the same bytes. Anything else is a storage conflict and the bundle is left unchanged.
async function writePredictionVersion(env,filmId,prediction){
 const text=predictionVersionText(prediction),sha256=await contentHash(predictionVersionBody(prediction)),key=predictionVersionKey(filmId,sha256);
 const saved=await env.BUCKET.put(key,text,{httpMetadata:{contentType:'application/json'},onlyIf:{etagDoesNotMatch:'*'}});
 if(saved===null){
  const existing=await env.BUCKET.get(key);
  const stored=existing?await existing.text():null;
  if(stored!==text)throw new Error('Prediction version object conflicts');
 }
 return predictionVersionPointer(filmId,sha256);
}
// The one-time materialization route of historical prediction versions is retired (ADR 0050); the plan rule stays in
// src/domain/prediction-versions.js for the offline tools.
async function textSha256(text){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');}
function ratingsStatusView(stored,enabled){
 const empty={schemaVersion:1,state:'idle',lastSuccessAt:null,lastFailureAt:null,nextRetryAt:null,generationId:null,pages:null,watched:null,attempt:null,diary:{state:'unchecked',cause:null,error:null}};
 return {...(stored||empty),enabled:!!enabled};
}
function applyRatingsSeed(index){
 let changed=false;
 for(const [id,rating] of Object.entries(typeof INITIAL_PERSONAL_RATINGS==='undefined'?{}:INITIAL_PERSONAL_RATINGS))if(!Object.hasOwn(index[id]||{},'actualRating')){index[id]={...(index[id]||{}),actualRating:rating};changed=true;}
 return changed;
}
async function readableRatings(env){
 const [pointer,pending]=await Promise.all([loadJSON(env,RATINGS_POINTER_KEY),loadJSON(env,RATINGS_PENDING_KEY)]);
 const generationId=pointer?.projected===true?pointer.generationId:null;
 const pendingGenerationId=pending?.generationId&&!pending.done&&pending.generationId!==generationId?pending.generationId:null;
 return {generationId,pendingGenerationId,pointer};
}
// Read-only prediction quality over stored history (contract: docs/reference/api/prediction-quality.md). One page of Letterboxd
// fact records per request: one bounded LIST, per record its bundles (Letterboxd and TMDB ids), the legacy log once, and the
// immutable object of each prospective pair. The response carries additive stats so a client can sum pages. Never a write.
const QUALITY_DEFAULT_LIMIT=25,QUALITY_MAX_LIMIT=50;
async function predictionQualityRoute(env,url){
 const raw=url.searchParams.get('limit');let limit=QUALITY_DEFAULT_LIMIT;
 if(raw!==null){if(!/^\d{1,2}$/.test(raw)||Number(raw)<1||Number(raw)>QUALITY_MAX_LIMIT)return json({error:'limit must be 1..'+QUALITY_MAX_LIMIT},400);limit=Number(raw);}
 const cursor=url.searchParams.get('cursor');
 if(cursor!==null&&!/^[A-Za-z0-9+/=_-]{1,1024}$/.test(cursor))return json({error:'Invalid cursor'},400);
 const read=async key=>{const object=await env.BUCKET.get(key);if(!object)return null;try{return await object.json();}catch{return undefined;}};
 const listing=await env.BUCKET.list({prefix:'letterboxd/facts/films/',limit,...(cursor?{cursor}:{})});
 const [legacyLog,profile]=await Promise.all([read(ratingObservationsKey),read(profileKey)]);
 let stats=emptyQualityStats();const films=[];
 for(const object of listing.objects||[]){
  const record=await read(object.key);
  if(record===undefined||!record){films.push({factKey:object.key.slice('letterboxd/facts/films/'.length).replace(/\.json$/,''),skipped:'unreadable'});continue;}
  if(record.redirectTo){films.push({factKey:record.factKey,skipped:'redirected'});continue;}
  if(record.migrating){films.push({factKey:record.factKey,skipped:'migration_in_progress'});continue;}
  const links=record.links||{},ids=[...(links.letterboxd?[String(links.letterboxd)]:[]),...(links.tmdb?['tmdb_'+links.tmdb]:[])];
  const events=[...buildFilmHistory({filmId:ids[0]||record.factKey,filmIds:ids,factRecord:record,legacyLog}).events];
  for(const id of ids){
   const bundle=await read(filmKey(id)+'predictions.json');
   if(!bundle)continue;
   for(const event of buildFilmHistory({filmId:id,bundle}).events)events.push({...event,identity:id+'|'+event.identity,filmId:id});
  }
  events.sort(compareHistoryEvents);
  const film=classifyFilmQuality(events);
  for(const item of film.ratings){
   if(item.class!=='prospective')continue;
   const holder=events.find(e=>e.identity===item.prediction.identity),bundle=holder?await read(filmKey(holder.filmId)+'predictions.json'):null;
   const position=holder?.position,record2=position==='current'?bundle?.current:bundle?.history?.[Number(holder.identity.split('|').pop())];
   if(record2?.r2Key||record2?.contentSha256){
    const linked=predictionVersionLinked(record2,holder.filmId),object2=linked?await env.BUCKET.get(record2.r2Key):null;
    const status=!linked?'invalid':!object2?'missing':await textSha256(await object2.text())===record2.contentSha256?'linked':'mismatch';
    item.prediction.version={status,r2Key:record2.r2Key??null,contentSha256:record2.contentSha256??null};
    if(status!=='linked'){item.class='excluded';item.reason='version_unverified';}
   }
  }
  addFilmQuality(stats,film);
  films.push({factKey:record.factKey,filmIds:ids,ratings:film.ratings.map(({prediction,...rest})=>({...rest,...(prediction?{prediction:{identity:prediction.identity,at:prediction.at,predictedRating:prediction.predictedRating,probability4Plus:prediction.probability4Plus,tasteProfileVersion:prediction.tasteProfileVersion,predictionPromptVersion:prediction.predictionPromptVersion,lineageKnown:prediction.runId!==null&&prediction.fingerprintPromptVersion!==null,versionStatus:prediction.version?.status||'none'}}:{})})),legacyUnverified:film.legacyUnverified});
 }
 return json({schemaVersion:PREDICTION_QUALITY_SCHEMA_VERSION,readAt:new Date().toISOString(),profile:profile?{version:profile.version??null,profileHash:profile.profileHash??null}:null,
  page:{limit,records:(listing.objects||[]).length,nextCursor:listing.truncated?listing.cursor:null},stats,metrics:finalizeQuality(stats),films});
}
// Read-only history of one film (contract: docs/reference/api/film-history.md). Only GET and HEAD-free reads of R2: the
// prediction bundle, the film's Letterboxd fact record through the link index, the legacy rating log and the profile, plus
// one read per immutable version object on the requested page. Never a write, a model call, a refresh or a lease.
async function filmHistoryRoute(env,url){
 const filmId=url.searchParams.get('filmId');
 if(typeof filmId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(filmId))return json({error:'filmId must be 1–80 letters, digits, "_" or "-"'},400);
 const page=filmHistoryPageRequest(url.searchParams);if(page.error)return json({error:page.error},400);
 const read=async key=>{const object=await env.BUCKET.get(key);if(!object)return {status:'missing',etag:null,value:null};try{return {status:'recorded',etag:object.etag,value:await object.json()};}catch{return {status:'unreadable',etag:object.etag,value:null};}};
 const bundle=await read(filmKey(filmId)+'predictions.json');
 const tmdb=/^tmdb_([1-9]\d{0,11})$/.exec(filmId),alias=tmdb?'tmdb:'+tmdb[1]:'letterboxd:'+filmId;
 const links=await read(LetterboxdFacts.FACTS_KEYS.links);
 let factKey=links.value?.[alias]||null,fact={status:'missing',etag:null,value:null};
 if(factKey){
  fact=await read(LetterboxdFacts.recordKey(factKey));
  if(fact.value?.redirectTo){factKey=fact.value.redirectTo;fact=await read(LetterboxdFacts.recordKey(factKey));}
  else if(fact.value?.migrating?.to){const target=await read(LetterboxdFacts.recordKey(fact.value.migrating.to));fact={status:fact.status,etag:fact.etag+'+'+target.etag,value:LetterboxdFacts.overlay(fact.value,target.value)};}
 }
 const factLinks=fact.value?.links||{},filmIds=[...new Set([filmId,...(factLinks.letterboxd?[String(factLinks.letterboxd)]:[]),...(factLinks.tmdb?['tmdb_'+factLinks.tmdb]:[])])];
 const [legacy,profile]=await Promise.all([read(ratingObservationsKey),read(profileKey)]);
 const digest=(await textSha256([bundle.etag,fact.etag,legacy.etag].map(value=>value||'-').join('|'))).slice(0,16);
 if(page.digest&&page.digest!==digest)return json({error:'history_changed',detail:'The stored history changed since this cursor was issued; start again without a cursor.'},409);
 const built=buildFilmHistory({filmId,filmIds,bundle:bundle.value,factRecord:fact.value,legacyLog:legacy.value,profile:profile.value});
 const slice=built.events.slice(page.offset,page.offset+page.limit);
 const records=new Map([...(Array.isArray(bundle.value?.history)?bundle.value.history:[]).map((record,i)=>['prediction|history|'+i,record]),...(bundle.value?.current?[['prediction|current|0',bundle.value.current]]:[])]);
 for(const event of slice){
  if(event.type!=='prediction')continue;
  const record=records.get(event.identity);
  if(!record?.r2Key&&!record?.contentSha256)continue;
  if(!predictionVersionLinked(record,filmId)){event.version={status:'invalid',r2Key:historyValue(record,'r2Key'),contentSha256:historyValue(record,'contentSha256')};continue;}
  const object=await env.BUCKET.get(record.r2Key);
  const status=!object?'missing':await textSha256(await object.text())===record.contentSha256?'linked':'mismatch';
  event.version={status,r2Key:record.r2Key,contentSha256:record.contentSha256};
 }
 const partial=[bundle,fact,legacy].some(source=>source.status==='unreadable')||slice.some(event=>event.type==='prediction'&&['missing','mismatch','invalid'].includes(event.version.status));
 const next=page.offset+page.limit<built.events.length?String(page.offset+page.limit)+'.'+digest:null;
 return json({schemaVersion:FILM_HISTORY_SCHEMA_VERSION,filmId,readAt:new Date().toISOString(),
  snapshot:{profile:profile.value?{version:profile.value.version??null,profileHash:profile.value.profileHash??null}:null,sources:{predictions:{status:bundle.status},facts:{status:factKey?fact.status:'missing',factKey},legacyRatingLog:{status:legacy.status}}},
  current:built.current,partial,notes:built.notes,events:slice,page:{limit:page.limit,offset:page.offset,total:built.events.length,nextCursor:next}});
}
async function enrichmentRoute(request,env,url,execution){const path=url.pathname,requestId=predictionRequestId(request);let body=null;
 // Retired before any body parsing, read or write: no Letterboxd request, no lease, no stored object touched (ADR 0040).
 if(path==='/api/enrichment/ratings/refresh')return json({error:'gone',detail:'The ratings-only refresh is retired. Ratings arrive with the EPG sync and the per-film lookup; stored ratings stay readable at GET /api/enrichment/ratings/status.'},410);
 // Retired before any body parsing, read or write: the historical materialization is complete, no flag reopens it (ADR 0050).
 if(path==='/api/enrichment/predictions/materialize')return json({error:'gone',detail:'The one-time prediction version materialization is retired. New predictions are written as immutable versions on submit; historical records were materialized and reconciled.'},410);
if(['POST','PUT'].includes(request.method)){try{body=await request.json();}catch{return json({error:'Invalid JSON'},400);}if(!isObject(body))return json({error:'Invalid request'},400);}
 if(path==='/api/enrichment/ratings/status'&&request.method==='GET'){const stored=await loadJSON(env,RATINGS_STATUS_KEY),readable=await readableRatings(env);return json({...ratingsStatusView(stored,false),generationId:readable.generationId??stored?.generationId??null,pendingGenerationId:readable.pendingGenerationId});}
 if(path==='/api/enrichment/catalog/posters'&&request.method==='POST')return await catalogPosterHydration(env,body);
 if(path==='/api/enrichment/discovery/reconcile'&&request.method==='POST'){
  // AIR-220 / ADR 0034: these routes rewrite the whole ledger and are not archive-aware yet.
  if(discoveryLedgerMode(env)!=='full'||await env.BUCKET.get(LEDGER_ARCHIVE_POINTER))return json({error:'Discovery ledger is bounded; this route is not archive-aware'},409);
  const pinned=await pinEpg(env);
  let [source,decisions]=await Promise.all([loadJSON(pinned,'epg/discovery-latest.json'),loadJSON(env,'epg/discovery-resolution.json')]);if(!source?.items)return json({error:'No discovery catalog'},409);
  if(source.canonicalizedAt&&source.canonicalizedAt!==decisions?.__canonicalizedAt){[source,decisions]=await Promise.all([loadJSON(env,'epg/discovery-before-canonical.json'),loadJSON(env,'epg/discovery-resolution-before-canonical.json')]);if(!source?.items)return json({error:'Canonicalization backup missing'},409);}
  let result;try{result=canonicalizeDiscoveryLedger(source,decisions||{});}catch(e){return json({error:String(e.message).slice(0,160)},409);}
  const changed=result.duplicatesRemoved>0||result.items.some((item,i)=>item.key!==source.items[i]?.key);
  if(changed){await saveJSON(env,'epg/discovery-before-canonical.json',source);await saveJSON(env,'epg/discovery-resolution-before-canonical.json',decisions||{});
   const at=new Date().toISOString();await updatePublishedFiles(env,{'discovery-latest.json':{...source,items:result.items,canonicalizedAt:at}});await saveJSON(env,'epg/discovery-resolution.json',{...result.decisions,__canonicalizedAt:at});}
  return json({changed,before:source.items.length,after:result.items.length,duplicatesRemoved:result.duplicatesRemoved,carriedVerified:result.carriedVerified,retried:result.retried});
 }
 if(path==='/api/enrichment/discovery/resolve'&&request.method==='POST')return await resolveDiscoveryRequest(env,execution,body);
 if(path==='/api/enrichment/discovery/scan'&&request.method==='POST'){
  // AIR-220 / ADR 0034: these routes rewrite the whole ledger and are not archive-aware yet.
  if(discoveryLedgerMode(env)!=='full'||await env.BUCKET.get(LEDGER_ARCHIVE_POINTER))return json({error:'Discovery ledger is bounded; this route is not archive-aware'},409);
  const pinned=await pinEpg(env);
  const report=await loadJSON(pinned,'programme.json');if(!report?.films)return json({error:'No programme'},409);
  const now=Date.now(),response=await fetch(sourceConfig(env).epg,{signal:AbortSignal.timeout(110000)});if(!response.ok)return json({error:'EPG HTTP '+response.status},502);
  const cache=await loadJSON(pinned,'epg/discovered-films.json')||{},known=new Set(report.films.map(f=>String(f.tmdbId)));const result=await scanEPG(response.body,[...report.films,...Object.values(cache).filter(f=>!known.has(String(f.tmdbId))).map(f=>({...f,catalogOnly:true}))],now);if(result.stats.epgEnd<now+8*3600000)return json({error:'EPG horizon too short'},502);
  const old=await loadJSON(pinned,'epg/discovery-latest.json'),items=mergeDiscoveryCandidates(old?.items,result.discovery,{replaceShows:true,programmeRunId:report.runId});const replaced=replaceCatalogAvailability(cache,result.discovery,report.runId);
  await updatePublishedFiles(env,{'discovery-latest.json':{programmeRunId:report.runId,updatedAt:new Date(now).toISOString(),rawCandidates:result.stats.rawCandidates,filteredNonMovies:result.stats.filteredNonMovies,items},'discovered-films.json':replaced.catalog});
  await refreshPredictionQueue(env,report,'epg_scan');const discovery=await queueDiscovery(env,'scan_committed',report.runId);return json({programmeRunId:report.runId,candidates:items.length,newCandidates:items.length-(old?.items?.length||0),scanned:result.stats.scanned,discovery});
 }
 if(['/api/enrichment/discovery/status','/api/enrichment/pipeline/status'].includes(path)&&request.method==='GET')return json(await discoveryPipelineStatus(env));
 // Read-only audit export. No lazy rating initialization, source fetch, or enrichment generation.
 if(path==='/api/enrichment/diagnostics/export'&&request.method==='GET'){
  const group=url.searchParams.get('group')||'global';
  if(group==='global'){const keys=['enrichment/diagnostics/baseline.json','enrichment/diagnostics/rating-observations.json','enrichment/view-index.json','enrichment/profile/current.json','epg/discovered-films.json','programme.json','watchlist.json','metadata.json','titles.json'];const records=await Promise.all(keys.map(async key=>{const object=await env.BUCKET.get(key);return {key,uploadedAt:object?.uploaded?.toISOString?.()||null,etag:object?.etag||null,value:object?await object.json():null};}));return json({exportedAt:new Date().toISOString(),group,records});}
  const prefixes={films:'enrichment/films/',sources:'enrichment/sources/',profiles:'enrichment/profile/versions/',runs:'enrichment/runs/'},prefix=prefixes[group],cursor=url.searchParams.get('cursor')||undefined;
  if(!prefix||cursor&&cursor.length>4000)return json({error:'Invalid export group or cursor'},400);
  const page=await env.BUCKET.list({prefix,limit:24,...(cursor?{cursor}:{})}),records=await Promise.all(page.objects.map(async item=>{const object=await env.BUCKET.get(item.key);return {key:item.key,uploadedAt:object?.uploaded?.toISOString?.()||item.uploaded?.toISOString?.()||null,etag:object?.etag||item.etag||null,value:object?await object.json():null};}));return json({exportedAt:new Date().toISOString(),group,records,nextCursor:page.truncated?page.cursor:null});
 }
 if(path==='/api/enrichment/diagnostics/freeze'&&request.method==='POST'){const result=await freezeDiagnosticSnapshot(env);return result.error?json({error:result.error},409):json({created:result.created,frozenAt:result.snapshot.frozenAt,programmeRunId:result.snapshot.programmeRunId,filmCount:result.snapshot.films.length,predictionCount:result.snapshot.films.filter(f=>!!f.prediction).length});}
 if(path==='/api/enrichment/history'&&request.method==='GET')return filmHistoryRoute(env,url);
 if(path==='/api/enrichment/quality'&&request.method==='GET')return predictionQualityRoute(env,url);
 if(path==='/api/enrichment/diagnostics/snapshot'&&request.method==='GET'){const snapshot=await loadJSON(env,diagnosticSnapshotKey);return snapshot?json(snapshot):json({error:'No frozen diagnostic snapshot'},404);}
 if(path==='/api/enrichment/diagnostics/accuracy'&&request.method==='GET'){const snapshot=await loadJSON(env,diagnosticSnapshotKey);return snapshot?json(prospectiveAccuracy(snapshot,await loadJSON(env,ratingObservationsKey)||[])):json({error:'No frozen diagnostic snapshot'},404);}
 if(path==='/api/enrichment/profile'&&request.method==='GET'){const p=await loadJSON(env,profileKey);return p?json(p):json({error:'Taste profile is not configured'},404);}
 if(path==='/api/enrichment/profile'&&request.method==='PUT')return publishProfile(env,body);
 if(path==='/api/enrichment/benchmark/start'&&request.method==='POST')return predictionWriter(env,()=>predictionBenchmarkStart(env));
 if(path==='/api/enrichment/benchmark/trial'&&request.method==='POST')return predictionWriter(env,()=>predictionBenchmarkTrial(env,body));
 if(path==='/api/enrichment/runner'&&request.method==='GET')return json(predictionRunnerContract());
 if(path==='/api/enrichment/heartbeat'&&request.method==='POST')return observedPrediction(env,body,()=>predictionWriter(env,()=>runnerHeartbeat(env,body)),'heartbeat',requestId);
 if(path==='/api/enrichment/start'&&request.method==='POST')return diagnosedStart(env,body,requestId);
 if(path==='/api/enrichment/runs'&&request.method==='GET'){const text=url.searchParams.get('limit')||'10';if(!/^\d+$/.test(text)||Number(text)<1||Number(text)>100)return json({error:'Invalid limit (1–100)'},400);return json(await diagnosticHistory(env,Number(text)));}
 if(path==='/api/enrichment/queue/reconcile'&&request.method==='POST'){const report=await loadJSON(env,'programme.json');const queue=await refreshPredictionQueue(env,report,'manual_reconcile');return queue?json(await queueStatus(env)):json({error:'Programme or taste profile unavailable'},409);}
 if(path==='/api/enrichment/queue/status'&&request.method==='GET')return json(await queueStatus(env)||{status:'not_initialized',pendingCount:null,...scheduledRunFields()});
 if(path==='/api/enrichment/footer/status'&&request.method==='GET')return json(await footerStatus(env));
 if(path==='/api/enrichment/next'&&request.method==='POST')return observedPrediction(env,body,()=>predictionWriter(env,()=>enrichmentNext(env,body)),'next',requestId);
 if(path==='/api/enrichment/submit'&&request.method==='POST')return observedPrediction(env,body,()=>predictionWriter(env,()=>enrichmentSubmit(env,body)),'submit',requestId);
 if(path==='/api/enrichment/complete'&&request.method==='POST')return observedPrediction(env,body,()=>predictionWriter(env,()=>enrichmentComplete(env,body)),'complete',requestId);
 if(path==='/api/enrichment/status'&&request.method==='GET'){await recoverStopEvents(env);return json(await enrichmentStatus(env));}
 if(path==='/api/enrichment/moods/diagnostics'&&request.method==='GET')return json(moodDiagnostics(await loadJSON(env,ENRICHMENT_KEY+'view-index.json')));
 if(path==='/api/enrichment/moods/backfill'&&request.method==='POST')return predictionWriter(env,()=>moodBackfill(env,body));
 if(path==='/api/enrichment/schema'&&request.method==='GET')return json({profile:{schemaVersion:1,required:['ratingScale','positiveSignals','negativeSignals','characterLogic','pace','payoffEnding','genrePreferences','comedyPreferences','horrorPreferences','scifiAdventurePreferences','actionPreferences','anchorFilms','hardSkips','calibration'],textFields:['ratingScale','characterLogic','pace','payoffEnding','genrePreferences','comedyPreferences','horrorPreferences','scifiAdventurePreferences','actionPreferences','calibration'],listFields:['positiveSignals','negativeSignals','hardSkips'],anchorFilms:{title:'string',rating:'0.5…5.0 in 0.5 steps',reason:'string'}},fingerprint:{fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,plotMechanics:MECHANICS,execution:EXECUTION,requiredExecution:GENERAL_EXECUTION,moodLabels:'2–4 short labels, preferably canonical vocabulary labels; raw input preserved and mapped at write',moodVocabulary:MOOD_LABELS,strengths:'short string array',risks:'short string array',confidence:CONFIDENCE,sourceBasis:SOURCE_BASIS,sourceRefs:'URL or model_knowledge'},prediction:{predictedRating:'0.5…5.0 in 0.5 steps',probability4Plus:'number 0…1',confidence:CONFIDENCE,matchSignals:'0–3 short strings',mainRisk:'one short string or null',moodLabels:'2–4 short labels, preferably canonical vocabulary labels; raw input preserved and mapped at write',moodVocabulary:MOOD_LABELS},contract:schemaContract(),rules:['Do not infer execution quality from premise alone; use unknown if evidence is insufficient','Do not use or request actual user rating for the target film','Check the fingerprint and prediction against contract before prediction_submit: every required execution dimension present, every enum value from its list (payoff and ending_quality use weak, mixed, strong, unknown, not medium; hero_vulnerability uses low, mixed, high, unknown), moodLabels 2–4 labels. A rejected item returns results[].validation.issues with the field path and code.']});
 if(path==='/api/enrichment/view'&&request.method==='GET')return json(await enrichmentView(env));
 if(path==='/api/enrichment/fingerprint-view/backfill'&&request.method==='POST')return backfillFingerprintView(env,body);
 if(path==='/api/enrichment/actual-ratings'&&request.method==='PUT'){if(!Array.isArray(body.items)||body.items.length>100)return json({error:'Expected items (max 100)'},400);const results=[];for(const item of body.items){const id=String(item?.filmId||''),rating=item?.rating;if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id)||!(rating===null||Number.isFinite(rating)&&rating>=.5&&rating<=5&&rating*2%1===0)){results.push({filmId:id,error:'Invalid film or rating'});continue;}const updatedAt=new Date().toISOString();if(env.LETTERBOXD_FACTS==='on'){const facts=await LetterboxdFacts.recordFilmFacts(env,id,{rating},{observedAt:updatedAt,source:'owner'});if(facts.conflict){results.push({filmId:id,error:'Identity conflict; recorded for review'});continue;}if(!facts.accepted||facts.record.rating?.value!==rating){results.push({filmId:id,status:'older',rating:facts.record.rating?.value??null});continue;}await saveJSON(env,filmKey(id)+'actual.json',{rating,source:'letterboxd',updatedAt});results.push({filmId:id,status:'saved'});continue;}await saveJSON(env,filmKey(id)+'actual.json',{rating,source:'letterboxd',updatedAt});await updateViewIndex(env,id,{actualRating:rating});results.push({filmId:id,status:'saved'});}return json({results});}
 if(path==='/api/enrichment/ratings/backfill'&&request.method==='POST')return ratingsBackfill(env,body);
 return json({error:'Not found'},404);
}
