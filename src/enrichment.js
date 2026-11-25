
// Versioned derived vocabulary: source fingerprints/predictions and their hashes stay immutable.
const MOOD_MAPPING_VERSION=2;
const MOOD_LABELS={tense:'Напряжённый',dark:'Мрачный',light:'Лёгкий',adventurous:'Приключенческий',dynamic:'Динамичный',epic:'Масштабный',violent:'Жёсткий',funny:'Комедийный',black_humor:'Чёрный юмор',satirical:'Сатирический',absurd:'Абсурдный',romantic:'Романтический',warm:'Тёплый',touching:'Трогательный',inspiring:'Вдохновляющий',melancholic:'Меланхоличный',tragic:'Трагический',contemplative:'Созерцательный',surreal:'Сюрреалистический',eerie:'Мистический / пугающий',paranoid:'Параноидальный',noir:'Нуарный',military:'Военная тема',historical:'Историческая тема',family:'Семья и отношения',friendship:'Дружба и команда',political:'Политика и общество',revenge:'Месть и возмездие'};
const MOOD_GROUPS={tone:['tense','dark','light','adventurous','dynamic','epic','funny','black_humor','satirical','romantic','warm','touching','inspiring','melancholic','tragic','contemplative','paranoid','eerie'],theme:['military','historical','political','family','friendship','revenge'],style:['noir','surreal','absurd'],property:['violent']};
function normalizeRawMood(value){return typeof value==='string'?value.normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim():'';}
const MOOD_RULES=[
 ['tense',/напряж|тревож|нервн|стресс|tense|suspense/],['dark',/мрач|темн|безысход|холодн|безнадеж|dark|bleak/],['light',/легк|светл|несерьез|lighthearted/],['adventurous',/приключ|авантюр|adventur/],['dynamic',/динамич|драйв|энергич|бодр|dynamic/],['epic',/масштаб|эпичес|эпос|эпопе|зрелищ|epic/],['violent',/жестк|жесток|кровав|брутал|агрессив|насили|violent/],['funny',/комеди|юмор|забав|смешн|comedy|funny/],['black_humor',/черн[^ ]* (?:криминальн[^ ]* )?(?:комеди|юмор)|black comedy|dark humor/],['satirical',/сатир|ирони|цинич|satir/],['absurd',/абсурд|гротеск|фарс|дураш|безумн|absurd/],['romantic',/романти|любов|страст|страсть|эротич|romantic/],['warm',/тепл|уют|рождеств|празднич|добродуш|warm/],['touching',/трогат|лирич|эмоциональн|touching/],['inspiring',/вдохнов|воодушев|исцелен|искуплен|inspir/],['melancholic',/меланхол|ностальг|скорб|melanchol/],['tragic',/трагич|трагед|неизбежн[^ ]* (?:гибель|смерть)|tragic/],['contemplative',/созерц|медитатив|философ|contemplative/],['surreal',/сюрреал|сновид|галлюцин|surreal/],['eerie',/мистич|паранорм|оккульт|готич|проклят|демон|ведьм|потусторон|экзорц|eerie/],['paranoid',/парано(?!рм)|недовер|ненадежн[^ ]* реальн|paranoid/],['noir',/нуар|noir/],['military',/военн|(?<!д)войн|(?<!кон)фронт|армад|солдат|морпех|воинск|танков|партизан|military|(?:^| )war(?: |$)/],['historical',/историч|средневек|(?<!ром)антич|костюмн|ретро|библейск|historical/],['family',/(?:^| )семь(?:я|и|е|ю)|(?:^| )семей(?: |$)|семейн|родител|материн|отец и|отца|отцов|сын(?: |$)|дочь|дочер|брач|брак(?!он)|сестрин|братск|family/],['friendship',/дружб|друз|братств|наставник|наставнич|buddy|friendship/],['political',/политич|политик|социальн|тоталитар|антиутоп|общество|коррупц|революц|politic/],['revenge',/месть|возмезд|revenge/]
];
const MOOD_MECHANIC_PHRASES=['осада','погоня','побег','спасение','выживание','расследование','загадка','тайна','ограбление','ограбления','афера','охота','защита','экспедиция','квест','похищение','эскорт','операция','миссия','план','противостояние','головоломка','головоломки','гонка со временем','ticking clock','survival','heist','cat and mouse','кошки мышки'];
function moodMechanicOnly(normalized){if(!normalized)return false;const tokens=normalized.split(' ');return MOOD_MECHANIC_PHRASES.some(phrase=>{const parts=phrase.split(' ');for(let i=0;i+parts.length<=tokens.length;i++)if(parts.every((part,offset)=>tokens[i+offset]===part))return true;return false;});}
function mapRawMood(raw){const normalized=normalizeRawMood(raw);if(Object.hasOwn(MOOD_LABELS,raw))return {raw,normalized,ids:[raw],status:'mapped'};const ids=MOOD_RULES.filter(([,pattern])=>pattern.test(normalized)).map(([id])=>id);return {raw,normalized,ids,status:ids.length?'mapped':moodMechanicOnly(normalized)?'mechanic_only':'unmapped'};}
function moodPresentationGroups(mapping){return (mapping||[]).filter(item=>item.status==='mapped'&&item.ids.length).map(item=>item.ids);}
function canonicalMoodFacet(fingerprint,prediction){const rawLabels=[...new Set([...(fingerprint?.moodLabels||[]),...(prediction?.moodLabels||[])])],mapping=rawLabels.map(mapRawMood);return {mappingVersion:MOOD_MAPPING_VERSION,rawLabels,moodIds:[...new Set(mapping.flatMap(m=>m.ids))].sort(),mapping,unmapped: mapping.filter(m=>m.status==='unmapped').map(m=>m.raw)};}
function moodDiagnostics(index){const raw=new Map(),canonicalCounts={};let films=0;for(const item of Object.values(index||{})){const facet=canonicalMoodFacet(item.fingerprint,item.prediction);if(!facet.rawLabels.length)continue;films++;for(const id of facet.moodIds)canonicalCounts[id]=(canonicalCounts[id]||0)+1;for(const m of facet.mapping){const entry=raw.get(m.raw)||{...m,filmCount:0};entry.filmCount++;raw.set(m.raw,entry);}}const mappings=[...raw.values()].sort((a,b)=>b.filmCount-a.filmCount||a.raw.localeCompare(b.raw,'ru'));return {mappingVersion:MOOD_MAPPING_VERSION,vocabulary:MOOD_LABELS,groups:MOOD_GROUPS,films,rawVariants:mappings.length,canonicalOptions:Object.keys(canonicalCounts).length,canonicalCounts,mappings,unmapped:mappings.filter(m=>m.status==='unmapped'),mechanicOnly:mappings.filter(m=>m.status==='mechanic_only')};}

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
// One Events object per committed current version. The id and timestamp come from that committed record, so a replay
// writes the same key and does not mint another. The object keeps field names and the scope only: not the profile,
// its hash, the approval or the declaration.
function tasteProfileEventFromCurrent(current){
 const at=current?.updatedAt,version=current?.version;
 if(typeof at!=='string'||!Number.isFinite(Date.parse(at))||!Number.isInteger(version)||version<1)return null;
 const impact=current.changeImpact,scope=impact?.scope==='selective'||impact?.scope==='global'||impact?.scope==='identity'?impact.scope:null;
 const changedFields=impact&&Array.isArray(impact.changedFields)?impact.changedFields.filter(field=>typeof field==='string'):[];
 const lineage=Array.isArray(current.lineage)?current.lineage:[],index=lineage.findIndex(link=>link?.version===version);
 const fromVersion=index>0&&Number.isInteger(lineage[index-1]?.version)?lineage[index-1].version:null;
 return {id:'taste-profile-'+version,type:'taste_profile',at,fromVersion,toVersion:version,changedFields,scope};
}
function sameCommittedPublication(current,body,profileHash){
 return !!current&&current.version===body.version&&current.profileHash===profileHash&&JSON.stringify(canonical(current.changeImpact??null))===JSON.stringify(canonical(body.changeImpact??null));
}
// Only a version body written by this publisher carries the marker. Historical current values do not, and a caller
// cannot add it: the replay reads the stored version, never the request. D1 rebuilds current from that version body.
function tasteProfileEventExpected(current){return current?.tasteProfileEventExpected===true;}
// Records the event for a current record that is already committed. A missing object is created. An object already
// stored for this version is left as it was. A write failure does not move current and does not throw.
async function ensureTasteProfileEvent(env,current){
 const event=tasteProfileEventFromCurrent(current);
 if(!event)return {recorded:false};
 try{
  const existing=await loadJSON(env,removalEventKey(event));
  if(existing)return existing.type==='taste_profile'&&existing.id===event.id&&existing.toVersion===event.toVersion?{recorded:true}:{recorded:false};
  await writeEvent(env,event);
  const stored=await loadJSON(env,removalEventKey(event));
  return stored?.type==='taste_profile'&&stored.id===event.id?{recorded:true}:{recorded:false};
 }catch{return {recorded:false};}
}
function publishedProfileResponse(value,eventState){
 if(eventState?.recorded)return json(value);
 return json({...value,publicationEvent:{recorded:false}});
}
async function publishProfile(env,body){
 if(body.dryRun!==undefined&&typeof body.dryRun!=='boolean')return json({error:'Invalid dryRun'},400);
 if(body.schemaVersion!==1||!Number.isInteger(body.version)||body.version<1)return json({error:'Invalid version or schemaVersion'},400);
 const issue=validateProfile(body.profile);if(issue)return json({error:issue},400);
 const head=typeof PredictionD1==='undefined'?null:await PredictionD1.openProfile(env),stored=head?null:await env.BUCKET.get(profileKey),current=head?head.value:(stored?await stored.json():null),currentEtag=head?head.object?.etag||null:stored?.etag||null;
 const profileHash=await contentHash(body.profile);
 if(current&&body.version<=current.version){
  if(body.dryRun!==true&&tasteProfileEventExpected(current)&&sameCommittedPublication(current,body,profileHash))await ensureTasteProfileEvent(env,current);
  return json({error:'Version must increase',code:'version_not_increasing'},409);
 }
 const next={version:body.version,profileHash},impact=body.changeImpact??null;
 let changedFields=profileChangedFields(null,body.profile),declarationSha256=null;
 if(current){
  const text=profileDeclarationText(impact,next);declarationSha256=text?await profileDeclarationHash(text):null;
  const checked=validateProfileImpact({previous:current,next:{...next,profile:body.profile},impact,declarationSha256,vocabulary:{mechanics:MECHANICS,execution:EXECUTION}});
  changedFields=checked.changedFields;
  if(!checked.ok)return json({error:'Invalid changeImpact',code:checked.code,changedFields,profileHash,declarationSha256},PROFILE_PUBLISH_STATUS[checked.code]||400);
 }else if(impact!=null)return json({error:'The first version has no predecessor',code:'from_mismatch',changedFields,profileHash},409);
 if(body.dryRun)return json({dryRun:true,valid:true,version:body.version,profileHash,changedFields,declarationSha256,from:current?{version:current.version,profileHash:current.profileHash}:null});
 const record={version:body.version,schemaVersion:1,updatedAt:new Date().toISOString(),profileHash,profile:body.profile,changeImpact:current?impact:null,tasteProfileEventExpected:true};
 const versionKey=ENRICHMENT_KEY+'profile/versions/'+body.version+'.json';
 let saved=record;
 if(await env.BUCKET.put(versionKey,JSON.stringify(record),{httpMetadata:{contentType:'application/json'},onlyIf:{etagDoesNotMatch:'*'}})===null){
  // A retry of the same publication finds its own record; any other record under this number is a conflict.
  const existing=await loadJSON(env,versionKey);
  if(!existing||existing.profileHash!==profileHash||JSON.stringify(canonical(existing.changeImpact??null))!==JSON.stringify(canonical(record.changeImpact)))return json({error:'Version record already exists',code:'version_exists'},409);
  saved=existing;
 }
 const value={...saved,lineage:profileLineage(current,saved)};
 let routed={handled:false};
 try{if(head)routed=await PredictionD1.saveMutable(env,profileKey,value);}
 catch(error){if(error?.code==='prediction_domain_cas')return json({error:'Current profile changed during publication; read it and publish again',code:'profile_changed'},409);throw error;}
 const moved=routed.handled?{etag:'d1'}:await env.BUCKET.put(profileKey,JSON.stringify(value),{httpMetadata:{contentType:'application/json'},onlyIf:currentEtag?{etagMatches:currentEtag}:{etagDoesNotMatch:'*'}});
 if(moved===null)return json({error:'Current profile changed during publication; read it and publish again',code:'profile_changed'},409);
 try{await refreshPredictionQueue(env,await loadJSON(env,'programme.json'),'profile_updated');}catch{}
 if(!tasteProfileEventExpected(value))return json(value);
 return publishedProfileResponse(value,await ensureTasteProfileEvent(env,value));
}
async function profileDeclarationHash(text){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');}
const MECHANICS=['heist','scam','investigation','mystery','chase_escape','rescue','escort_protection','survival','siege','ticking_clock','expedition_discovery','puzzle','plan_counterplan','multi_party_conflict'];
const EXECUTION={plot_engine:['weak','medium','strong','unknown'],pace:['slow','medium','fast','variable','unknown'],stakes:['low','medium','high','unknown'],decision_logic:['weak','mixed','strong','unknown'],protagonist_competence:['low','mixed','high','unknown'],opposition_competence:['low','mixed','high','not_applicable','unknown'],problem_solving:['weak','medium','strong','unknown'],plan_counterplan_strength:['none','weak','medium','strong','unknown'],multi_party_goals:['none','weak','medium','strong','unknown'],chemistry:['weak','medium','strong','unknown'],payoff:['weak','mixed','strong','unknown'],ending_quality:['weak','mixed','strong','unknown'],technical_plausibility:['weak','mixed','strong','not_applicable','unknown'],action_readability:['weak','mixed','strong','unknown'],hero_vulnerability:['low','mixed','high','unknown'],comedy_stupidity_for_gags:['low','mixed','high','unknown'],comedy_gross_out:['low','mixed','high','unknown'],horror_rule_consistency:['weak','mixed','strong','unknown'],horror_threat_causality:['weak','mixed','strong','unknown'],scifi_plot_driven_concept:['weak','medium','strong','unknown'],adventure_discovery_strength:['weak','medium','strong','unknown']};
const GENERAL_EXECUTION=['plot_engine','pace','stakes','decision_logic','protagonist_competence','opposition_competence','problem_solving','plan_counterplan_strength','multi_party_goals','chemistry','payoff','ending_quality','technical_plausibility'];
const GENRE_EXECUTION=Object.keys(EXECUTION).filter(key=>!GENERAL_EXECUTION.includes(key));
// AIR-152: one declarative contract drives the submit validator and GET /api/enrichment/schema,
// so a caller can run the same checks before prediction_batch_submit. Every rule value is a constant
// from this file; a rule never carries caller data.
const CONFIDENCE=['low','medium','high'],SOURCE_BASIS=['metadata','model_knowledge','web_research','mixed'];
const FINGERPRINT_MAX_CHARS=12000;
// Optional evidence beside the schema-1 rules (AIR-46). Omitting the key keeps today's caller-owned sourceBasis and
// sourceRefs. When the key is present it is hashed with the content, checked here, and a disagreeing aggregate is
// rejected rather than rewritten. Schema, prompt and the transition registry stay where they are; nothing here asks a
// caller to start sending the map.
const EVIDENCE_BASIS=['metadata','model_knowledge','web_research'];
const METADATA_REFS=['metadata:synopsis','metadata:genres','metadata:runtime','metadata:credits'];
// Metadata tokens may support a visible mechanic. Every execution dimension is a quality claim: a claim whose items
// are all metadata is rejected. Genre dimensions stay optional, so a concrete genre value with no items is still valid.
const EXECUTION_QUALITY=[...GENERAL_EXECUTION,...GENRE_EXECUTION];
const EVIDENCE_MAX_ITEMS=4,EVIDENCE_MAX_REFS=4,EVIDENCE_SOURCE_REF_CAP=8;
const EVIDENCE_CONTRACT={
 required:false,whenAbsent:'legacy',keys:['plotMechanics','execution'],itemKeys:['basis','refs','confidence'],
 basis:EVIDENCE_BASIS,confidence:CONFIDENCE,metadataRefs:METADATA_REFS,maxItems:EVIDENCE_MAX_ITEMS,maxRefs:EVIDENCE_MAX_REFS,sourceRefCap:EVIDENCE_SOURCE_REF_CAP,
 metadataSupports:['plotMechanics'],executionQuality:EXECUTION_QUALITY,
 claimCoverage:{plotMechanics:'every asserted mechanic has 1–4 items; no extra mechanic keys',generalExecution:'a value other than unknown or not_applicable requires items; unknown, not_applicable and an absent dimension must not have items',genreExecution:'optional; the same item rules when a genre dimension is present'},
 sourceFields:{whenOmitted:'when evidence is present and valid and BOTH sourceBasis and sourceRefs are omitted, the Worker sets them from the aggregate (ADR 0129)',whenSupplied:'a supplied value is never rewritten and must equal the aggregate',invalidEvidence:'an invalid map derives nothing; its own issues are reported'},
 aggregate:{order:['plotMechanics','generalExecution','genreExecution'],basis:'first-seen unique bases in that order; one basis keeps its name and more than one is mixed',refs:'first-seen unique refs in that order, capped at sourceRefCap'},
 metadataPreflight:'prediction_batch_validate accepts optional per-item metadata, the film modelMetadata, only when evidence cites a metadata token. The tool reads no storage. Submit uses the modelMetadata stored for the run. A metadata token whose fact is absent is invalid_ref.'
};
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
const ISSUE_CODES=['required','invalid_type','invalid_version','invalid_enum','too_few','too_many','empty','too_long','out_of_range','invalid_step','invalid_ref','too_large','unknown_field'];
const MAX_ISSUES=20;
// Returns [{path, code}] with path = <root>[.<field>[.<subfield>]] from the rule tables and code from ISSUE_CODES.
// Field order follows the rule table; a text-list item issue is reported once per field, without the item.
function ruleIssues(root,rules,value,closed){
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
 // Closed contract (ADR 0132): a key the table does not declare is rejected, never copied; the key in the path is sanitised and truncated, its value is never echoed.
 if(closed)for(const key of Object.keys(value)){if(!Object.hasOwn(rules,key)&&!(closed.ignore||[]).includes(key))add(root+'.'+key.replace(/[^A-Za-z0-9_]/g,'_').slice(0,40),'unknown_field');}
 return issues;
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
function metadataListPresent(value){return typeof value==='string'&&value.trim().length>0||Array.isArray(value)&&value.some(item=>typeof item==='string'&&item.trim().length>0);}
function metadataFactPresent(metadata,ref){
 if(!isObject(metadata))return false;
 if(ref==='metadata:synopsis')return typeof metadata.synopsis==='string'&&metadata.synopsis.trim().length>0;
 if(ref==='metadata:genres')return metadataListPresent(metadata.genres);
 if(ref==='metadata:runtime')return Number.isFinite(metadata.runtime)&&metadata.runtime>0||typeof metadata.runtime==='string'&&metadata.runtime.trim().length>0;
 if(ref==='metadata:credits')return metadataListPresent(metadata.directors)||metadataListPresent(metadata.actors)||metadataListPresent(metadata.credits);
 return false;
}
// Walk order for the aggregate is the asserted mechanic list, then general execution, then genre execution.
// Within a claim, item order is the submitted order. Unique bases and refs keep that first-seen order.
function evidenceCore(fingerprint,metadata,out){
 const issues=[],add=(path,code)=>{if(issues.length<MAX_ISSUES)issues.push({path,code});};
 const evidence=fingerprint.evidence;
 if(!isObject(evidence)){add('fingerprint.evidence','invalid_type');return issues;}
 if(Object.keys(evidence).some(key=>key!=='plotMechanics'&&key!=='execution'))add('fingerprint.evidence','invalid_type');
 const claims=[];
 const readItems=(path,raw,required,quality,concrete)=>{
  if(raw===undefined){if(required)add(path,'required');return;}
  if(!concrete){add(path,'invalid_enum');return;}
  if(!Array.isArray(raw)){add(path,'invalid_type');return;}
  if(!raw.length){add(path,'too_few');return;}
  if(raw.length>EVIDENCE_MAX_ITEMS){add(path,'too_many');return;}
  const seen=new Set();let clean=true,metadataOnly=true;const parsed=[];
  for(const item of raw){
   if(!isObject(item)||Object.keys(item).some(key=>key!=='basis'&&key!=='refs'&&key!=='confidence')){add(path,'invalid_type');clean=false;continue;}
   const {basis,refs,confidence}=item;
   if(typeof basis!=='string'){add(path,'invalid_type');clean=false;}
   else if(!EVIDENCE_BASIS.includes(basis)){add(path,'invalid_enum');clean=false;}
   if(typeof confidence!=='string'){add(path,'invalid_type');clean=false;}
   else if(!CONFIDENCE.includes(confidence)){add(path,'invalid_enum');clean=false;}
   if(!Array.isArray(refs)){add(path,'invalid_type');clean=false;continue;}
   if(!refs.length){add(path,'too_few');clean=false;continue;}
   if(refs.length>EVIDENCE_MAX_REFS){add(path,'too_many');clean=false;continue;}
   if(refs.some(ref=>typeof ref!=='string')){add(path,'invalid_type');clean=false;continue;}
   if(refs.some(ref=>ref.length>500)){add(path,'too_long');clean=false;continue;}
   const dup=new Set();let refsOk=EVIDENCE_BASIS.includes(basis);
   for(const ref of refs){
    if(dup.has(ref)){add(path,'invalid_ref');refsOk=false;break;}
    dup.add(ref);
    if(basis==='metadata'&&(!METADATA_REFS.includes(ref)||!metadataFactPresent(metadata,ref))){add(path,'invalid_ref');refsOk=false;break;}
    else if(basis==='model_knowledge'&&ref!=='model_knowledge'){add(path,'invalid_ref');refsOk=false;break;}
    else if(basis==='web_research'&&!evidenceUrlOk(ref)){add(path,'invalid_ref');refsOk=false;break;}
   }
   if(!refsOk)clean=false;
   if(basis!=='metadata')metadataOnly=false;
   const stamp=JSON.stringify(canonical({basis,refs,confidence}));
   if(seen.has(stamp)){add(path,'invalid_ref');clean=false;}else seen.add(stamp);
   if(refsOk&&EVIDENCE_BASIS.includes(basis)&&CONFIDENCE.includes(confidence))parsed.push({basis,refs,confidence});
  }
  if(clean&&quality&&metadataOnly){add(path,'invalid_ref');return;}
  if(!clean)return;
  claims.push({items:parsed});
 };
 const mechanics=[];
 if(Array.isArray(fingerprint.plotMechanics))for(const key of fingerprint.plotMechanics)if(typeof key==='string'&&!mechanics.includes(key))mechanics.push(key);
 const plot=evidence.plotMechanics;
 if(plot===undefined){if(mechanics.length)add('fingerprint.evidence.plotMechanics','required');}
 else if(!isObject(plot))add('fingerprint.evidence.plotMechanics','invalid_type');
 else{
  for(const key of Object.keys(plot))if(!mechanics.includes(key))add('fingerprint.evidence.plotMechanics.'+key,'invalid_enum');
  for(const key of mechanics)readItems('fingerprint.evidence.plotMechanics.'+key,plot[key],true,false,MECHANICS.includes(key));
 }
 const execution=isObject(fingerprint.execution)?fingerprint.execution:{};
 const concrete=key=>typeof execution[key]==='string'&&execution[key]!=='unknown'&&execution[key]!=='not_applicable'&&EXECUTION[key].includes(execution[key]);
 const block=evidence.execution;
 if(block===undefined){if(GENERAL_EXECUTION.some(concrete))add('fingerprint.evidence.execution','required');}
 else if(!isObject(block))add('fingerprint.evidence.execution','invalid_type');
 else{
  for(const key of Object.keys(block))if(!Object.hasOwn(EXECUTION,key))add('fingerprint.evidence.execution.'+key,'invalid_enum');
  for(const key of [...GENERAL_EXECUTION,...GENRE_EXECUTION]){
   if(!Object.hasOwn(block,key)){if(GENERAL_EXECUTION.includes(key)&&concrete(key))add('fingerprint.evidence.execution.'+key,'required');continue;}
   readItems('fingerprint.evidence.execution.'+key,block[key],GENERAL_EXECUTION.includes(key)&&concrete(key),EXECUTION_QUALITY.includes(key),concrete(key));
  }
 }
 if(issues.length)return issues;
 if(!claims.some(claim=>claim.items.length)){add('fingerprint.evidence','too_few');return issues;}
 const bases=[],refs=[];
 for(const claim of claims)for(const item of claim.items){if(!bases.includes(item.basis))bases.push(item.basis);for(const ref of item.refs)if(!refs.includes(ref)&&refs.length<EVIDENCE_SOURCE_REF_CAP)refs.push(ref);}
 if(out){out.basis=bases.length===1?bases[0]:'mixed';out.refs=refs;}
 if(fingerprint.sourceBasis!==(bases.length===1?bases[0]:'mixed'))add('fingerprint.sourceBasis','invalid_enum');
 const got=fingerprint.sourceRefs;
 if(!Array.isArray(got)||got.length!==refs.length||got.some((ref,index)=>ref!==refs[index]))add('fingerprint.sourceRefs','invalid_ref');
 return issues;
}
function evidenceIssues(fingerprint,metadata){return evidenceCore(fingerprint,metadata,null);}
// ADR 0129: when evidence is present and the caller omitted BOTH sourceBasis and sourceRefs, the Worker sets them from the aggregate it already
// computes and checks (the same walk order, de-duplication and cap of 8). A value the caller supplied is never rewritten: a disagreeing aggregate stays a
// rejection. An invalid evidence map derives nothing, so the caller sees the evidence issues. The result is a new object; the input is not changed.
function deriveFingerprintSource(fingerprint,metadata){
 if(!isObject(fingerprint)||!isObject(fingerprint.evidence)||Object.hasOwn(fingerprint,'sourceBasis')||Object.hasOwn(fingerprint,'sourceRefs'))return fingerprint;
 const out={};evidenceCore(fingerprint,metadata,out);
 return out.basis===undefined?fingerprint:{...fingerprint,sourceBasis:out.basis,sourceRefs:out.refs};
}
function withDerivedSource(item,metadata){return isObject(item)&&isObject(item.fingerprint)?{...item,fingerprint:deriveFingerprintSource(item.fingerprint,metadata)}:item;}
function fingerprintIssues(f,metadata){
 const issues=ruleIssues('fingerprint',FINGERPRINT_RULES,f);
 if(isObject(f)&&Object.hasOwn(f,'evidence')){
  // The rule table only knows https and model_knowledge. An evidence object may also cite the four metadata tokens,
  // so that one code is decided by the aggregate below instead of the table.
  if(isObject(f.evidence)){const kept=issues.filter(issue=>!(issue.path==='fingerprint.sourceRefs'&&issue.code==='invalid_ref'));issues.length=0;issues.push(...kept);}
  const found=evidenceIssues(f,metadata);
  // an invalid map derives nothing; its own issues are the cause, so the two omitted aggregate fields are not reported as missing on top of them
  if(found.length){for(let i=issues.length-1;i>=0;i--)if(issues[i].code==='required'&&(issues[i].path==='fingerprint.sourceBasis'||issues[i].path==='fingerprint.sourceRefs')&&!Object.hasOwn(f,issues[i].path.slice('fingerprint.'.length)))issues.splice(i,1);}
  for(const issue of found){if(issues.length>=MAX_ISSUES)break;if(!issues.some(have=>have.path===issue.path&&have.code===issue.code))issues.push(issue);}
 }
 if(isObject(f)&&!issues.length&&JSON.stringify(f).length>FINGERPRINT_MAX_CHARS)issues.push({path:'fingerprint',code:'too_large'});
 return issues;
}
function predictionIssues(p){return ruleIssues('prediction',PREDICTION_RULES,p,{ignore:['confidenceAssessment']});}
// Only the six declared model fields reach a stored version (ADR 0132); validation has already rejected anything else.
function pickPrediction(p){const out={};for(const k of Object.keys(PREDICTION_RULES))if(p[k]!==undefined)out[k]=p[k];return out;}
const issueText=issues=>issues.length?'Invalid '+issues.map(issue=>issue.path+' '+issue.code).join(', '):null;
function validateFingerprint(f){return issueText(fingerprintIssues(f));}
function validatePrediction(p){return issueText(predictionIssues(p));}
// ADR 0132: the optional per-film assessment of a v2 submit item. Caller content in a closed key set; the Worker checks shape and consistency only and verifies no source.
const ASSESSMENT_MAX_BYTES=3000;
const ASSESSMENT_CONTRACT={version:1,required:false,protocols:['batch_v2'],maxSerializedBytes:ASSESSMENT_MAX_BYTES,maxIssues:20,
 fields:{assessmentVersion:{const:1},ratingBasis:{text:[1,700]},probability4PlusBasis:{text:[1,400]},tasteSignals:{maxItems:5,item:{direction:['supports','against','neutral'],signal:{text:[1,220]},anchor:{text:[1,120],optional:true}}},risks:{maxItems:3,item:{risk:{text:[1,220]},severity:['low','medium','high']}},uncertainties:{maxItems:3,item:{text:[1,220]}},
  research:{status:['not_attempted','attempted_blocked','attempted_no_findings','attempted_found'],attempts:{maxItems:4,item:{outcome:['blocked','unreadable','irrelevant'],ref:{https:true,optional:true},note:{text:[1,100],optional:true}}}},
  sources:{maxItems:6,item:{kind:['metadata','model_knowledge','web_research'],ref:{accept:['metadata:synopsis|genres|runtime|credits','model_knowledge','https://… URL']},usedFor:{text:[1,120]},access:{values:['full_text','partial_text','search_snippet'],requiredWhen:'kind=web_research',forbiddenOtherwise:true}}},
  conflicts:{maxItems:2,item:{topic:{text:[1,120]},positions:{minItems:2,maxItems:3,item:{source:'integer index into sources; an index may repeat only when every position naming it carries a distinct author',author:{text:[1,80],optional:true,callerReported:true,requiredWhen:'source index repeats within the conflict'},stance:{text:[1,160]}}},handling:['kept_unresolved','weighted','not_relied_on']}},
  model:{status:['reported','unavailable'],reported:{id:{text:[1,80]},version:{text:[1,40],optional:true},effort:{text:[1,20],optional:true}}}},
 consistency:'research.status attempted_found needs at least one web_research source; every other status forbids one; not_attempted forbids attempts; access only on web_research; conflict positions name valid sources; a repeated source index needs distinct non-empty authors',
 stored:'immutable create-only R2 object per prediction version; caller content is reported, not confirmed'};
function assessmentIssues(a,metadata){
 const issues=[],add=(path,code)=>{if(issues.length<MAX_ISSUES)issues.push({path,code});};
 if(a===undefined)return issues;
 if(!isObject(a)){add('assessment','invalid_type');return issues;}
 let bytes=0;try{bytes=new TextEncoder().encode(JSON.stringify(a)).length;}catch{add('assessment','invalid_type');return issues;}
 if(bytes>ASSESSMENT_MAX_BYTES){add('assessment','too_large');return issues;}
 const text=(path,x,max,opt)=>{if(x===undefined){if(!opt)add(path,'required');return;}if(typeof x!=='string')add(path,'invalid_type');else if(!x.trim().length)add(path,'empty');else if(x.length>max)add(path,'too_long');};
 const closed=(path,x,keys)=>{for(const key of Object.keys(x))if(!keys.includes(key))add(path+'.'+key.replace(/[^A-Za-z0-9_]/g,'_').slice(0,40),'unknown_field');};
 const oneOf=(path,x,values,opt)=>{if(x===undefined){if(!opt)add(path,'required');}else if(typeof x!=='string')add(path,'invalid_type');else if(!values.includes(x))add(path,'invalid_enum');};
 const list=(path,x,min,max)=>{if(x===undefined){add(path,'required');return false;}if(!Array.isArray(x)){add(path,'invalid_type');return false;}if(x.length<min)add(path,'too_few');if(x.length>max){add(path,'too_many');return false;}return true;};
 closed('assessment',a,['assessmentVersion','ratingBasis','probability4PlusBasis','tasteSignals','risks','uncertainties','research','sources','conflicts','model']);
 if(a.assessmentVersion===undefined)add('assessment.assessmentVersion','required');else if(a.assessmentVersion!==1)add('assessment.assessmentVersion','invalid_version');
 text('assessment.ratingBasis',a.ratingBasis,700);text('assessment.probability4PlusBasis',a.probability4PlusBasis,400);
 const each=(path,x,min,max,fn)=>{if(list(path,x,min,max)){let bad=false;x.forEach(v=>{if(!isObject(v)){bad=true;}else fn(v);});if(bad)add(path,'invalid_type');}};
 each('assessment.tasteSignals',a.tasteSignals,0,5,v=>{closed('assessment.tasteSignals',v,['direction','signal','anchor']);oneOf('assessment.tasteSignals.direction',v.direction,['supports','against','neutral']);text('assessment.tasteSignals.signal',v.signal,220);text('assessment.tasteSignals.anchor',v.anchor,120,true);});
 each('assessment.risks',a.risks,0,3,v=>{closed('assessment.risks',v,['risk','severity']);text('assessment.risks.risk',v.risk,220);oneOf('assessment.risks.severity',v.severity,['low','medium','high']);});
 if(list('assessment.uncertainties',a.uncertainties,0,3)){if(a.uncertainties.some(v=>typeof v!=='string'))add('assessment.uncertainties','invalid_type');else if(a.uncertainties.some(v=>!v.trim().length))add('assessment.uncertainties','empty');else if(a.uncertainties.some(v=>v.length>220))add('assessment.uncertainties','too_long');}
 const urlOk=v=>typeof v==='string'&&evidenceUrlOk(v);
 const sources=Array.isArray(a.sources)?a.sources:[];
 let webSources=0;
 each('assessment.sources',a.sources,0,6,v=>{closed('assessment.sources',v,['kind','ref','usedFor','access']);oneOf('assessment.sources.kind',v.kind,['metadata','model_knowledge','web_research']);text('assessment.sources.usedFor',v.usedFor,120);
  if(v.ref===undefined)add('assessment.sources.ref','required');else if(typeof v.ref!=='string')add('assessment.sources.ref','invalid_type');
  else if(v.kind==='metadata'){if(!METADATA_REFS.includes(v.ref)||!metadataFactPresent(metadata,v.ref))add('assessment.sources.ref','invalid_ref');}
  else if(v.kind==='model_knowledge'){if(v.ref!=='model_knowledge')add('assessment.sources.ref','invalid_ref');}
  else if(v.kind==='web_research'){if(!urlOk(v.ref))add('assessment.sources.ref','invalid_ref');}
  if(v.kind==='web_research'){webSources++;oneOf('assessment.sources.access',v.access,['full_text','partial_text','search_snippet']);}
  else if(v.access!==undefined&&v.kind!==undefined)add('assessment.sources.access','invalid_enum');});
 if(Array.isArray(a.sources)&&new Set(a.sources.filter(isObject).map(v=>v.kind+'|'+v.ref)).size!==a.sources.filter(isObject).length)add('assessment.sources','invalid_ref');
 if(a.research===undefined)add('assessment.research','required');
 else if(!isObject(a.research))add('assessment.research','invalid_type');
 else{const r=a.research;closed('assessment.research',r,['status','attempts']);oneOf('assessment.research.status',r.status,['not_attempted','attempted_blocked','attempted_no_findings','attempted_found']);
  const attempts=r.attempts;
  if(attempts!==undefined){if(list('assessment.research.attempts',attempts,0,4)){if(r.status==='not_attempted'&&attempts.length)add('assessment.research.attempts','too_many');let bad=false;for(const v of attempts){if(!isObject(v)){bad=true;continue;}closed('assessment.research.attempts',v,['outcome','ref','note']);oneOf('assessment.research.attempts.outcome',v.outcome,['blocked','unreadable','irrelevant']);if(v.ref!==undefined&&!urlOk(v.ref))add('assessment.research.attempts.ref','invalid_ref');text('assessment.research.attempts.note',v.note,100,true);}if(bad)add('assessment.research.attempts','invalid_type');}}
  if(Array.isArray(a.sources)&&a.sources.length<=6){if(r.status==='attempted_found'&&webSources===0)add('assessment.sources','too_few');else if(['not_attempted','attempted_blocked','attempted_no_findings'].includes(r.status)&&webSources>0)add('assessment.research.status','invalid_enum');}}
 each('assessment.conflicts',a.conflicts,0,2,v=>{closed('assessment.conflicts',v,['topic','positions','handling']);text('assessment.conflicts.topic',v.topic,120);oneOf('assessment.conflicts.handling',v.handling,['kept_unresolved','weighted','not_relied_on']);
  if(list('assessment.conflicts.positions',v.positions,2,3)){const bySource=new Map();let bad=false;for(const p of v.positions){if(!isObject(p)){bad=true;continue;}closed('assessment.conflicts.positions',p,['source','author','stance']);text('assessment.conflicts.positions.stance',p.stance,160);text('assessment.conflicts.positions.author',p.author,80,true);
    if(p.source===undefined)add('assessment.conflicts.positions.source','required');else if(!Number.isInteger(p.source))add('assessment.conflicts.positions.source','invalid_type');else if(p.source<0||p.source>=sources.length)add('assessment.conflicts.positions.source','out_of_range');else{if(!bySource.has(p.source))bySource.set(p.source,[]);bySource.get(p.source).push(p);}}
   for(const group of bySource.values()){if(group.length<2)continue;const names=group.map(p=>typeof p.author==='string'?p.author.trim().toLowerCase():'');if(names.some(n=>!n)){if(group.some(p=>p.author===undefined))add('assessment.conflicts.positions.author','required');}else if(new Set(names).size!==names.length)add('assessment.conflicts.positions','invalid_ref');}
   if(bad)add('assessment.conflicts.positions','invalid_type');}});
 const m=a.model;
 if(m===undefined)add('assessment.model','required');
 else if(!isObject(m))add('assessment.model','invalid_type');
 else if(m.status===undefined)add('assessment.model.status','required');
 else if(m.status==='unavailable')closed('assessment.model',m,['status']);
 else if(m.status==='reported'){closed('assessment.model',m,['status','id','version','effort']);text('assessment.model.id',m.id,80);text('assessment.model.version',m.version,40,true);text('assessment.model.effort',m.effort,20,true);}
 else add('assessment.model.status',typeof m.status==='string'?'invalid_enum':'invalid_type');
 return issues;
}
function schemaContract(){return {version:1,fingerprint:{rules:FINGERPRINT_RULES,maxChars:FINGERPRINT_MAX_CHARS,evidence:EVIDENCE_CONTRACT},prediction:{rules:PREDICTION_RULES},assessment:ASSESSMENT_CONTRACT,issueCodes:ISSUE_CODES,issuePath:'<fingerprint|prediction|assessment>[.<field>[.<dimension or evidence group>[.<claim>]]]; a list issue names the list, not the item',reportedVia:'POST /api/enrichment/batch/submit (MCP prediction_batch_submit) results[].validation {stage, reportedBy, issues[{path, code}]}'};}
const fingerprintCurrent=f=>!!f&&f.fingerprintSchemaVersion===FINGERPRINT_SCHEMA_VERSION&&!f.invalidatedAt;
function executionFacet(execution){const out={};if(!execution||typeof execution!=='object')return out;for(const key of GENERAL_EXECUTION){const value=execution[key];if(typeof value==='string'&&EXECUTION[key].includes(value)&&value!=='unknown'&&value!=='not_applicable')out[key]=value;}return out;}
// The display facet of a usable fingerprint: exact today; exact or compatible when the caller judged it under the transition rule.
const fingerprintFacet=(f,usable=fingerprintCurrent(f))=>usable&&f?{plotMechanics:f.plotMechanics||[],moodLabels:f.moodLabels||[],execution:executionFacet(f.execution),fingerprintHash:f.fingerprintHash}:null;
// Selective compatibility (ADR-0031) needs what the display facet drops: the raw execution values (unknown, not_applicable,
// genre-specific dimensions) and the schema of the exact fingerprint. Copied from the full fingerprint, bound to its hash.
const fingerprintImpactFacet=f=>f&&typeof f.fingerprintHash==='string'&&f.fingerprintHash?{fingerprintHash:f.fingerprintHash,fingerprintSchemaVersion:f.fingerprintSchemaVersion??null,fingerprintPromptVersion:f.fingerprintPromptVersion??null,invalidatedAt:f.invalidatedAt||null,plotMechanics:Array.isArray(f.plotMechanics)?[...f.plotMechanics]:null,execution:isObject(f.execution)?{...f.execution}:null}:null;
const predictionCurrent=(p,profile,f)=>!!p&&!!profile&&fingerprintCurrent(f)&&p.tasteProfileVersion===profile.version&&p.tasteProfileHash===profile.profileHash&&p.fingerprintHash===f.fingerprintHash&&p.fingerprintSchemaVersion===FINGERPRINT_SCHEMA_VERSION&&p.predictionPromptVersion===PREDICTION_PROMPT_VERSION;
// The state a batch start needs to decide freshness and to build a manifest: the fingerprint and the current prediction, without the replaced versions.
async function readFilmStateCurrent(env,id){const key=filmKey(id);const [fingerprint,predictions]=await Promise.all([loadJSON(env,key+'fingerprint.json'),loadJSON(env,key+'predictions.json',{currentOnly:true})]);return {fingerprint,predictions};}
async function readFilmState(env,id){const key=filmKey(id);const [fingerprint,predictions]=await Promise.all([loadJSON(env,key+'fingerprint.json'),loadJSON(env,key+'predictions.json')]);return {fingerprint,predictions};}
function cloneJSON(value){return JSON.parse(JSON.stringify(value));}
async function mergeStoredJSON(env,key,empty,apply){
 if(auxKeyKind(key)==='stage'){
  const aux=await auxAuthority(env);
  if(aux)return PredictionAux.mergeStage(auxDb(env),aux,apply,{measure:item=>new TextEncoder().encode(JSON.stringify(heldItemBody(item))).length,guard:auxGuardOf(env),writer:env?.[WRITER_OWNER]||null});
 }
 if(typeof RatingsD1!=='undefined'&&RatingsD1.ratingsMutableKey(key)){try{const owned=await RatingsD1.casOwned(env,key,empty,async current=>apply(current));if(owned.owned)return owned.result.value;}catch(error){if(error.code==='write_contention')throw new Error('Stored JSON changed during write');throw error;}}
 for(let attempt=0;attempt<5;attempt++){
  const object=await env.BUCKET.get(key),current=object?await object.json():cloneJSON(empty),next=await apply(cloneJSON(current));
  if(next==null)return current;
  const saved=await env.BUCKET.put(key,JSON.stringify(next),{httpMetadata:{contentType:'application/json'},onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});
  if(saved!==null)return next;
 }
 throw new Error('Stored JSON changed during write');
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
async function saveActualMirror(env,key,body){if(typeof RatingsD1!=='undefined'&&await RatingsD1.ratingsReady(env))return;await saveJSON(env,key,body);}
async function refreshPersonalRating(env,film){
 const id=String(film.id),match=String(film.url||'').match(/^https:\/\/letterboxd\.com\/film\/([a-z0-9-]+)\/$/);if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id)||!match)throw new Error('Invalid Letterboxd film identity');
 const username=sourceConfig(env).letterboxdUsername,sourceUrl=`https://letterboxd.com/${username}/film/${match[1]}/`,requestedAt=new Date().toISOString();let response;
 // AIR-604 (ADR 0211 decision 5): the shared Letterboxd cooldown, re-checked HERE at the real request (the removal queue also peeks before its claim, but a cooldown can appear during the
 // awaited plan and claim). A skip throws the typed `upstream_cooldown` error; the removal phase releases the claim without charging the attempt. The body is read once: an ok answer here
 // (then handed to the shared classifier, so a challenge page behind a 200 is a blocked answer and never a `not_rated` verdict), any other status only as a bounded prefix while coordination is on.
 const coordination=upstreamCoordinator(env,'removal-rating');
 try{response=await(coordination?coordination.guard(fetch):fetch)(sourceUrl,{headers:{'User-Agent':'Mozilla/5.0 (compatible; WatchlistAirtime/1.0)','Accept':'text/html'},signal:AbortSignal.timeout(15000)});}catch(e){if(e?.code==='upstream_cooldown')throw e;throw new Error('Rating lookup failed: '+e.message);}
 // The status and the headers are recorded FIRST and on their own, and a known challenge is a blocked answer BEFORE any entity verdict: a 404 or a 200 with a challenge header is never `not_found`
 // or `not_rated`, and a failed body read cannot hide it. A challenge page behind a 200 is found in the one body read below.
 let signal=coordination?await coordination.after('letterboxd',{status:response.status,headers:response.headers,html:''}):null;
 if(signal&&signal.reason==='challenge')throw new Error('Rating source HTTP 403');
 let body=null;
 if(response.ok){body=await response.text();if(coordination&&!signal){signal=await coordination.after('letterboxd',{status:200,headers:response.headers,html:body});if(signal&&signal.reason==='challenge')throw new Error('Rating source HTTP 403');}}
 else if(coordination&&!signal&&response.status!==404&&await coordination.active()){signal=await coordination.after('letterboxd',{status:response.status,headers:response.headers,html:await UpstreamCooldown.readBodyBounded(response,32768)});if(signal&&signal.reason==='challenge')throw new Error('Rating source HTTP 403');}
 if(response.status===404)return {filmId:id,status:'not_found'};if(!response.ok)throw new Error('Rating source HTTP '+response.status);
 const rating=parsePersonalRating(body,film.url,username);if(rating===null)return {filmId:id,status:'not_rated'};
 const facts=await LetterboxdFacts.recordFilmFacts(env,id,{watched:true,rating},{observedAt:requestedAt,source:'letterboxd_film_page',sourceRef:sourceUrl});if(facts.conflict)return {filmId:id,status:'identity_conflict'};const saved=facts.outcomes.some(o=>o.outcome==='new'||o.outcome==='replaces');if(saved&&facts.record.rating?.value===rating)await saveActualMirror(env,filmKey(id)+'actual.json',{rating,source:'letterboxd',sourceUrl,updatedAt:requestedAt});await enrichRecentRemovalRatings(env,{[id]:rating},requestedAt);return {filmId:id,status:saved?'saved':'unchanged',rating};
}
// The removal rating queue (ADR 0060, ADR 0077). A film removed from the watchlist waits here until the Ratings step in
// src/letterboxd-ratings.js rates it from its own member page, so a removal event gets its rating without the 31-page films
// list. The EPG commit only hands removed films over and never looks them up (ADR 0074). The queue is bounded, each attempt
// is recorded before its request (a killed request cannot loop), a 403 or 429 stops the batch, and a film is retried at
// most REMOVAL_LOOKUP_MAX_ATTEMPTS times. No rating found never means watched. REMOVAL_RATING_LOOKUP is retired and unread.
const REMOVAL_LOOKUP_KEY=ENRICHMENT_KEY+'removal-rating-lookups.json';
const REMOVAL_LOOKUP_BATCH=5,REMOVAL_FACT_BATCH=5,REMOVAL_LOOKUP_MAX_ATTEMPTS=3,REMOVAL_LOOKUP_CAP=100,REMOVAL_LOOKUP_KEEP_MS=14*86400000;
const REMOVAL_LOOKUP_RETRY_MS={claimed:3600000,failed:3600000,blocked:6*3600000,rate_limited:6*3600000,not_rated:24*3600000};
const removalLookupFilm=film=>{const id=String(film?.id??''),url=String(film?.url||'');return /^[a-zA-Z0-9_-]{1,80}$/.test(id)&&/^https:\/\/letterboxd\.com\/film\/[a-z0-9-]+\/$/.test(url)?{id,url}:null;};
// Queue schema version 2 (ADR 0060 decision 3): `films[id]` stays the unit of lookup; `refs` lists every removal event
// that removed the film, `{eventKey, sourceRunId, at, resolved}`. Every mutation below is applied inside the
// read-apply-compare-and-swap retry of mergeStoredJSON and branches on the `schemaVersion` of the content read in that
// retry, so a writer that read version 1 before a migration follows version 2 once it lands on a migrated queue.
const REMOVAL_LOOKUP_REFS_MAX=20;
const REMOVAL_EVENT_KEY=/^events\/items\/\d{13}-[A-Za-z0-9_-]{1,160}\.json$/;
const removalQueueV2=queue=>queue?.schemaVersion===2;
function removalRef(ref){
 const eventKey=String(ref?.eventKey||'');if(!REMOVAL_EVENT_KEY.test(eventKey))return null;
 return {eventKey,sourceRunId:typeof ref.sourceRunId==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(ref.sourceRunId)?ref.sourceRunId:null,at:typeof ref.at==='string'&&Number.isFinite(Date.parse(ref.at))?ref.at:null,resolved:false};
}
const removalEntryResolved=entry=>(entry?.refs||[]).every(ref=>ref.resolved===true);
const removalUnresolvedRefs=entry=>(entry?.refs||[]).filter(ref=>ref.resolved!==true).length;
// Adds an absent (film, eventKey) pair. A replay of the same event adds nothing; a new reference on a finished entry
// reopens it (pending, no attempts, fresh enqueuedAt, no claim). Past 20 references the oldest resolved one is dropped,
// or the oldest unresolved one when none is resolved, and counted in `droppedRefs`. Without a reference (no event to
// name) an absent film becomes a `legacy` entry that promises nothing for an event.
function addRemovalRef(queue,film,ref,at){
 const entry=queue.films[film.id];
 if(!entry){queue.films[film.id]={url:film.url,state:'pending',attempts:0,enqueuedAt:at,nextAttemptAt:at,lastAttemptAt:null,lastResult:null,claim:null,refs:ref?[ref]:[],...(ref?{}:{legacy:true})};return true;}
 if(!ref)return false;
 const refs=Array.isArray(entry.refs)?entry.refs:[];
 if(refs.some(item=>item.eventKey===ref.eventKey))return false;
 const next=[...refs,ref];
 if(next.length>REMOVAL_LOOKUP_REFS_MAX){
  const order=(a,b)=>String(a.at||'')<String(b.at||'')?-1:String(a.at||'')>String(b.at||'')?1:a.eventKey<b.eventKey?-1:a.eventKey>b.eventKey?1:0;
  const resolved=next.filter(item=>item.resolved===true).sort(order),victim=(resolved.length?resolved:[...next].sort(order))[0];
  next.splice(next.indexOf(victim),1);queue.droppedRefs=(queue.droppedRefs||0)+1;
 }
 const updated={...entry,url:entry.url||film.url,refs:next};delete updated.legacy;
 if(entry.state!=='pending')Object.assign(updated,{state:'pending',attempts:0,enqueuedAt:at,nextAttemptAt:at,claim:null});
 queue.films[film.id]=updated;return true;
}
// One enqueue, by the version of the queue read in this retry: version 1 queues an absent film id (ADR 0043), version 2
// adds the (film, event) reference.
function applyRemovalEnqueue(queue,films,ref,at){
 let changed=false;
 if(!removalQueueV2(queue)){for(const {id,url} of films)if(!queue.films[id]){queue.films[id]={url,state:'pending',attempts:0,enqueuedAt:at,nextAttemptAt:at,lastAttemptAt:null,lastResult:null};changed=true;}return changed;}
 const reference=removalRef(ref);
 for(const film of films)if(addRemovalRef(queue,film,reference?{...reference}:null,at))changed=true;
 return changed;
}
// The claim before a request. Version 2 also stores a random claim token: only the outcome carrying it is accepted.
function claimRemovalEntry(queue,id,now,at,token){
 const entry=queue.films[id];if(!entry||entry.state!=='pending'||Date.parse(entry.nextAttemptAt)>now)return false;
 if(removalQueueV2(queue)&&!(entry.attempts<REMOVAL_LOOKUP_MAX_ATTEMPTS))return false;
 queue.films[id]={...entry,attempts:entry.attempts+1,lastAttemptAt:at,nextAttemptAt:new Date(now+REMOVAL_LOOKUP_RETRY_MS.claimed).toISOString(),lastResult:'claimed',...(removalQueueV2(queue)?{claim:{token,at}}:{})};
 return true;
}
const removalClaimHeld=(queue,id,at,token)=>{const entry=queue?.films?.[id];if(!entry||entry.lastResult!=='claimed')return false;return removalQueueV2(queue)?entry.claim?.token===token:entry.lastAttemptAt===at;};
// The outcome of a claimed request. Version 2 accepts it only while the claim token is the caller's and the entry is
// still pending; a reopened entry has no claim, so a late outcome of the earlier lookup is refused (its attempt counted).
function applyRemovalOutcome(queue,id,result,error,at,now,token){
 const entry=queue.films[id];if(!entry)return false;
 if(removalQueueV2(queue)&&(entry.state!=='pending'||entry.claim?.token!==token))return false;
 const next=removalLookupOutcome(entry,result,error,at);if(removalQueueV2(queue))next.claim=null;
 queue.films[id]=next;
 if(next.lastResult==='blocked'||next.lastResult==='rate_limited'){queue.pausedUntil=new Date(now+REMOVAL_LOOKUP_RETRY_MS[next.lastResult]).toISOString();queue.pausedBy=next.lastResult;}
 return true;
}
// A rating the diary proved resolves the film's entry on the spot (version 2 only): `rated`, `lastResult: diary`.
function resolveRemovalByDiary(queue,id,rating,at){
 const entry=queue.films[id];if(!removalQueueV2(queue)||!entry||entry.state==='rated'||confirmedHalfStar(rating)==null)return false;
 queue.films[id]={...entry,state:'rated',rating,lastResult:'diary',checkedAt:at,nextAttemptAt:null,claim:null,lastError:null};
 return true;
}
// A confirmed stored rating resolves a pending entry without a request (ADR 0077). A reopened entry is pending and
// still carries its previous rating; the fact wins. Null and absence do not resolve it and do not mean watched.
function resolveRemovalByFact(queue,id,rating,at){
 const entry=queue.films[id],confirmed=confirmedHalfStar(rating);
 if(!removalQueueV2(queue)||!entry||entry.state!=='pending'||confirmed==null)return false;
 queue.films[id]={...entry,state:'rated',rating:confirmed,lastResult:'fact',checkedAt:at,nextAttemptAt:null,claim:null,lastError:null};
 return true;
}
// Due pending entries whose fact store already holds a confirmed rating, before any member-page GET. At most `limit`
// films are probed (REMOVAL_FACT_BATCH). The alias index and the films-list floor are read once; each probe then reads
// that film's record. `skip` is the films the current Diary page listed without a rating: they are eligible for a GET
// without a probe. `gettable` is the only set a caller may request. Anything not visited stays pending. `beforeEach`
// stops the step when the ratings lease is inside its margin; the direct helper does not pass one and uses this cap alone.
async function resolveDueRemovalFacts(env,now=Date.now(),options={}){
 const skip=options.skip||[],limit=options.limit??REMOVAL_FACT_BATCH,getBudget=options.getBudget??REMOVAL_LOOKUP_BATCH,beforeEach=options.beforeEach||(()=>true);
 const at=new Date(now).toISOString(),held=new Set(skip);
 let queue=await loadJSON(env,REMOVAL_LOOKUP_KEY);
 if(!queue)return {queue,gettable:[],more:false};
 if(!removalQueueV2(queue)){const due=removalDue(queue,now,getBudget+1);return {queue,gettable:due.slice(0,getBudget),more:due.length>getBudget};}
 const due=removalDue(queue,now,Object.keys(queue.films).length),gettable=[];
 let probes=0,index=0,yielded=false,cache=null;
 for(;index<due.length;index++){
  if(!beforeEach()){yielded=true;break;}
  const id=due[index];
  if(held.has(id)){if(gettable.length>=getBudget){yielded=true;break;}gettable.push(id);continue;}
  if(probes>=limit){yielded=true;break;}
  if(!cache)cache={links:(await loadJSON(env,LetterboxdFacts.FACTS_KEYS.links))||{},filmsList:await loadJSON(env,LetterboxdFacts.FACTS_KEYS.filmsList)};
  if(!beforeEach()){yielded=true;break;}
  probes++;
  const rating=await LetterboxdFacts.confirmedFilmRating(env,id,cache);
  if(rating!=null){
   if(!beforeEach()){yielded=true;break;}
   let resolved=false;
   queue=await mergeStoredJSON(env,REMOVAL_LOOKUP_KEY,REMOVAL_QUEUE_EMPTY,q=>{resolved=resolveRemovalByFact(q,id,rating,at);return resolved?q:null;});
   if(resolved){if(!beforeEach()){yielded=true;break;}await settleRemovalRefs(env,{ids:[id],now});}
  }else if(gettable.length>=getBudget){yielded=true;break;}
  else gettable.push(id);
 }
 return {queue:await loadJSON(env,REMOVAL_LOOKUP_KEY),gettable,more:yielded||index<due.length};
}
// Version 2 retention: an entry with an unresolved reference is never deleted, by age or by the cap. A pending entry
// still expires after 14 days (no more requests). Only entries whose references are all resolved (legacy entries
// included) follow the version 1 rules below.
function pruneRemovalLookupsV2(queue,now){
 let changed=false;const old=entry=>!(now-Date.parse(entry.enqueuedAt)<=REMOVAL_LOOKUP_KEEP_MS);
 for(const [id,entry] of Object.entries(queue.films)){
  if(entry.state==='pending'){if(old(entry)){queue.films[id]={...entry,state:'expired',nextAttemptAt:null,claim:null};changed=true;}continue;}
  if(!removalEntryResolved(entry))continue;
  if(entry.state!=='expired'&&old(entry)||entry.state==='expired'&&now-Date.parse(entry.enqueuedAt)>2*REMOVAL_LOOKUP_KEEP_MS){delete queue.films[id];changed=true;}
 }
 const finished=Object.keys(queue.films).filter(id=>queue.films[id].state!=='pending'&&removalEntryResolved(queue.films[id]));
 if(finished.length>REMOVAL_LOOKUP_CAP){for(const id of finished.sort((a,b)=>Date.parse(queue.films[a].enqueuedAt)-Date.parse(queue.films[b].enqueuedAt)).slice(0,finished.length-REMOVAL_LOOKUP_CAP))delete queue.films[id];changed=true;}
 return changed;
}
const pruneRemovalQueue=(queue,now)=>removalQueueV2(queue)?pruneRemovalLookupsV2(queue,now):pruneRemovalLookups(queue,now);
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
const removalDue=(queue,now,limit)=>Object.entries(queue.films).filter(([,entry])=>entry.state==='pending'&&entry.attempts<REMOVAL_LOOKUP_MAX_ATTEMPTS&&Date.parse(entry.nextAttemptAt)<=now)
 .sort(([,a],[,b])=>Date.parse(a.enqueuedAt)-Date.parse(b.enqueuedAt)).slice(0,limit).map(([id])=>id);
const REMOVAL_QUEUE_EMPTY={schemaVersion:1,films:{}};
// The durable enqueue of the EPG commit under the separate pipeline (ADR 0060 decision 3): references only, no request.
// The retired binding is not read (ADR 0077). Idempotent: a replay of the same event adds nothing.
async function enqueueRemovalRefs(env,incoming,ref,now=Date.now()){
 const at=new Date(now).toISOString(),films=(Array.isArray(incoming)?incoming:[]).map(removalLookupFilm).filter(Boolean);
 let schemaVersion=null;
 await mergeStoredJSON(env,REMOVAL_LOOKUP_KEY,REMOVAL_QUEUE_EMPTY,q=>{schemaVersion=q.schemaVersion;return applyRemovalEnqueue(q,films,ref,at)?q:null;});
 return {films:films.length,schemaVersion,at};
}
// A rated legacy entry (ADR 0060 decision 3, the version-1 shape `refs: []`) stored a confirmed rating and named no
// event. linkLegacyRemovalRefs attaches removal events of that exact film id without reopening the entry and without a
// Letterboxd request. One list page per call; the cursor lives on the queue (`legacyLink`) until that scan is done.
// An entry the scan does not match keeps `legacy` and `legacyLink.done`, so a later step does not list again. A match
// drops `legacy` once the scan is done and leaves the new references unresolved for settleRemovalRefs. A rating already
// on the entry is not replaced, and a film id that differs (another year, an alias) is not a match. A cleanup deletes
// only the scan this call read: the same ids and cursor, and only while those ids are still not candidates. A newer
// cursor stays. `advanced` is true only when this call's queue write commits, so a late step does not count another
// scan's page. The EPG commit does not call this.
const LEGACY_LINK_PAGE=20;
const removalRefOrder=(a,b)=>String(a.at||'')<String(b.at||'')?-1:String(a.at||'')>String(b.at||'')?1:a.eventKey<b.eventKey?-1:a.eventKey>b.eventKey?1:0;
const legacyLinkCandidate=entry=>!!entry&&entry.legacy===true&&entry.state==='rated'&&confirmedHalfStar(entry.rating)!=null&&entry.legacyLink?.done!==true;
const legacyLinkCandidates=queue=>Object.entries(queue?.films||{}).filter(([,entry])=>legacyLinkCandidate(entry));
function attachLegacyRef(queue,id,ref){
 const entry=queue.films[id];if(!legacyLinkCandidate(entry))return false;
 const refs=Array.isArray(entry.refs)?entry.refs:[];if(refs.some(item=>item.eventKey===ref.eventKey))return false;
 const next=[...refs,ref];
 if(next.length>REMOVAL_LOOKUP_REFS_MAX){
  const resolved=next.filter(item=>item.resolved===true).sort(removalRefOrder),victim=(resolved.length?resolved:[...next].sort(removalRefOrder))[0];
  next.splice(next.indexOf(victim),1);queue.droppedRefs=(queue.droppedRefs||0)+1;
 }
 queue.films[id]={...entry,refs:next};return true;
}
async function linkLegacyRemovalRefs(env,{limit=LEGACY_LINK_PAGE,now=Date.now()}={}){
 const at=new Date(now).toISOString(),summary={listed:0,linked:0,more:false,done:false,skipped:true,advanced:false,scanning:false};
 const stored=await loadJSON(env,REMOVAL_LOOKUP_KEY);
 if(!removalQueueV2(stored))return summary;
 const open=legacyLinkCandidates(stored),scan=stored.legacyLink&&Array.isArray(stored.legacyLink.ids)?stored.legacyLink:null;
 if(!scan&&!open.length)return summary;
 summary.skipped=false;
 if(scan&&!scan.ids.some(id=>legacyLinkCandidate(stored.films[id]))){
  let cleared=false;
  const saved=await mergeStoredJSON(env,REMOVAL_LOOKUP_KEY,REMOVAL_QUEUE_EMPTY,q=>{
   cleared=false;
   const current=q.legacyLink&&Array.isArray(q.legacyLink.ids)?q.legacyLink:null;
   if(!current||JSON.stringify(current.ids)!==JSON.stringify(scan.ids)||(current.cursor||null)!==(scan.cursor||null))return null;
   if(current.ids.some(id=>legacyLinkCandidate((q.films||{})[id])))return null;
   delete q.legacyLink;cleared=true;return q;
  });
  summary.advanced=cleared;summary.scanning=!!saved.legacyLink;
  summary.more=summary.scanning||legacyLinkCandidates(saved).length>0;summary.done=!summary.more;return summary;
 }
 if(typeof env.BUCKET.list!=='function')return summary;
 const scanIds=scan?scan.ids:open.map(([id])=>id).sort(),cursor=scan?.cursor||null,wanted=new Set(scanIds);
 const page=await env.BUCKET.list({prefix:'events/items/',limit,...(cursor?{cursor}:{})});
 const objects=page?.objects||[];summary.listed=objects.length;const matches=[];
 for(const item of objects){
  if(!REMOVAL_EVENT_KEY.test(item.key))continue;
  const event=await loadJSON(env,item.key);
  if(event?.type!=='watchlist'||!Array.isArray(event.removed))continue;
  const ref=removalRef({eventKey:item.key,at:event.at,sourceRunId:null});if(!ref)continue;
  const seen=new Set();
  for(const film of event.removed){const id=String(film?.id??'');if(!wanted.has(id)||seen.has(id))continue;seen.add(id);matches.push({id,ref});}
 }
 const truncated=page?.truncated===true&&typeof page.cursor==='string'&&page.cursor.length>0&&page.cursor!==cursor;
 let linked=0,committed=false;
 const saved=await mergeStoredJSON(env,REMOVAL_LOOKUP_KEY,REMOVAL_QUEUE_EMPTY,q=>{
  linked=0;committed=false;if(!removalQueueV2(q))return null;
  const current=q.legacyLink&&Array.isArray(q.legacyLink.ids)?q.legacyLink:null;
  const starting=!current&&!cursor,same=!!current&&JSON.stringify(current.ids)===JSON.stringify(scanIds)&&(current.cursor||null)===(cursor||null);
  if(!starting&&!same)return null;
  let changed=false;
  for(const match of matches)if(attachLegacyRef(q,match.id,match.ref)){linked++;changed=true;}
  if(!truncated){
   for(const id of scanIds){
    const entry=q.films[id];if(!entry||entry.legacy!==true||entry.legacyLink?.done===true||entry.state!=='rated'||confirmedHalfStar(entry.rating)==null)continue;
    const updated={...entry,legacyLink:{done:true,at,matched:(entry.refs||[]).length}};
    if((updated.refs||[]).length)delete updated.legacy;
    if(updated.legacy!==entry.legacy||entry.legacyLink?.done!==true){q.films[id]=updated;changed=true;}
   }
   if(q.legacyLink){delete q.legacyLink;changed=true;}
  }else{q.legacyLink={ids:scanIds,cursor:page.cursor,startedAt:current?.startedAt||at};changed=true;}
  if(!changed)return null;
  committed=true;return q;
 });
 summary.linked=linked;summary.scanning=!!saved.legacyLink;
 summary.more=summary.scanning||legacyLinkCandidates(saved).length>0;summary.done=!summary.more;
 summary.advanced=committed;
 return summary;
}
// Rated version 2 entries with unresolved references: the rating is written to each referenced removal event with the
// writeEvent compare-and-swap and merge, and the reference is marked resolved only once the stored event lists the film
// as removed with a confirmed rating. A kill between the two repeats the idempotent event write. Every attempt stamps
// the reference's `checkedAt`; one that cannot be resolved keeps `issue`: `event_missing` (the event is not stored,
// e.g. a commit that never wrote it), `film_not_in_event` or `event_unrated`. Work is taken least recently checked
// first, so references that never resolve cannot starve later ones; `checkedBefore` skips references already checked
// since that time (one ratings run visits each reference once).
const REMOVAL_REF_ISSUES=['event_missing','film_not_in_event','event_unrated'];
async function settleRemovalRefs(env,{ids=null,limit=20,now=Date.now(),checkedBefore=null,onPlan=null}={}){
 const at=new Date(now).toISOString(),summary={written:0,resolved:0,waiting:0,mismatched:0,left:0};
 const queue=await loadJSON(env,REMOVAL_LOOKUP_KEY);
 if(!removalQueueV2(queue))return summary;
 const work=[];
 for(const [id,entry] of Object.entries(queue.films)){
  if(ids&&!ids.includes(id)||entry.state!=='rated'||confirmedHalfStar(entry.rating)==null)continue;
  for(const ref of entry.refs||[])if(ref.resolved!==true&&!(checkedBefore&&ref.checkedAt&&ref.checkedAt>=checkedBefore))work.push({id,eventKey:ref.eventKey,checkedAt:ref.checkedAt||'',rating:entry.rating,observedAt:entry.checkedAt||null});
 }
 work.sort((a,b)=>a.checkedAt<b.checkedAt?-1:a.checkedAt>b.checkedAt?1:a.id<b.id?-1:a.id>b.id?1:a.eventKey<b.eventKey?-1:a.eventKey>b.eventKey?1:0);
 summary.left=Math.max(0,work.length-limit);
 // AIR-393: the references this call is about to settle are handed to the caller first, so a kill after a settlement can still be recovered from a stored intent.
 if(onPlan&&work.length)await onPlan(work.slice(0,limit).map(item=>({id:item.id,eventKey:item.eventKey,rating:item.rating})));
 for(const item of work.slice(0,limit)){
  let event=await loadJSON(env,item.eventKey),issue=null;
  if(event){
   const next=withRemovalRatings(event,{[item.id]:item.rating},item.observedAt);
   if(next){event=await writeEvent(env,next);summary.written++;}
   const film=(event?.type==='watchlist'&&Array.isArray(event.removed)?event.removed:[]).find(value=>String(value?.id)===item.id);
   issue=!film?'film_not_in_event':removalRating(film)?null:'event_unrated';

  }else issue='event_missing';
  await mergeStoredJSON(env,REMOVAL_LOOKUP_KEY,REMOVAL_QUEUE_EMPTY,q=>{
   const ref=removalQueueV2(q)?(q.films[item.id]?.refs||[]).find(value=>value.eventKey===item.eventKey):null;
   if(!ref||ref.resolved===true)return null;
   ref.checkedAt=at;if(issue)ref.issue=issue;else{ref.resolved=true;delete ref.issue;}
   return q;
  });
  if(!issue)summary.resolved++;else if(issue==='event_missing')summary.waiting++;else summary.mismatched++;
 }
 return summary;
}
async function freezeDiagnosticSnapshot(env){
 const existing=await loadJSON(env,diagnosticSnapshotKey);if(existing)return {snapshot:existing,created:false};
 const [programme,index,profile]=await Promise.all([loadJSON(env,'programme.json'),readViewIndex(env),loadJSON(env,profileKey)]);
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
function policyExcludedEnrichmentFilm(film){
 return typeof policyExcludedPresentedFilm==='function'?policyExcludedPresentedFilm(film):false;
}
function allEnrichmentFilms(report,catalog){const watchlist=eligibleEnrichmentFilms(report),seen=new Set(),films=[];for(const film of [...watchlist,...Object.values(catalog||{}).sort((a,b)=>String(a.id).localeCompare(String(b.id),'en'))]){if(policyExcludedEnrichmentFilm(film))continue;const identity=film.tmdbId?'tmdb:'+String(film.tmdbId):'legacy:'+String(film.id);if(seen.has(identity))continue;seen.add(identity);films.push(film);}return films.sort((a,b)=>String(a.id).localeCompare(String(b.id),'en'));}
function modelMetadata(film){return {id:String(film.id),letterboxdUri:film.url?.startsWith('https://letterboxd.com/')?film.url:null,tmdbUri:film.tmdbId?'https://www.themoviedb.org/movie/'+film.tmdbId:null,title:film.title,original:film.original,year:film.year,genres:film.genres,synopsis:film.synopsis,directors:film.directors,actors:film.actors,runtime:film.runtime||null};}
// nextCatchUpAt() is the Worker's own earliest-retry gate for discovery `wait`: the next whole UTC hour. It throttles
// a new chunk series to one per clock hour. It is not a ChatGPT Scheduled Task time: the Worker does not store or
// derive the external Predictions registry recurrence (see docs/reference/scheduled-tasks.md).
const nextCatchUpAt=()=>new Date(Math.floor(Date.now()/3600000+1)*3600000).toISOString();
// Prediction wire fields keep the names for compatibility. Both are null: the Worker does not know the next
// external Task invocation. Discovery `wait` uses its own nextCatchUpAt as the gate; these names are not that gate.
const scheduledRunFields=()=>({nextCatchUpAt:null,nextScheduledRunAt:null});
// A paused exhausted chunk_budget is not "running" merely because its checkpoint is younger than 48 hours.
// After the discovery gate it stays waiting for two hours plus this slack. That duration is the Worker's own
// stall detector for the Cloudflare Discovery Workflow; it is not two ChatGPT Task slots. A live resolver lease
// is running on its own and is not part of the slack. Exactly at the end the state stays waiting. This clock
// does not read the task registry or any usage account, and millisecond addition is independent of DST.
const RESOLVER_PROGRESS_EPOCHS=2;
const RESOLVER_PROGRESS_SLACK_MS=45*60*1000;
function resolverProgressGraceEnd(gateMs){
 if(!Number.isFinite(gateMs))return null;
 const end=gateMs+RESOLVER_PROGRESS_EPOCHS*3600000+RESOLVER_PROGRESS_SLACK_MS;
 return Number.isFinite(end)?end:null;
}
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
// AIR-477 (ADR 0165, Accepted). The owner-confirmed recovery intents, read at each call (one D1 batch of two SELECTs; there is no request
// cache since AIR-452 removed the request scope): a film's exact denied prediction (and fingerprint) version is not current for every
// consumer that names the film. An absent module, binding or migration 0024 is the empty overlay: the ordinary rule alone decides. An
// INSTALLED store that cannot be read (a fault, a partial table set) fails closed: the error reaches the caller, so no rebuild treats a
// recovery film as current and no queue write drops its retry record on that answer.
const NO_RECOVERY_OVERLAY=Object.freeze({ready:false,revision:null,size:0,deniesPrediction:()=>false,deniesFingerprint:()=>false,modeOf:()=>null,activeIds:()=>[],confirmedAtOf:()=>null});
async function predictionRecoveryOverlay(env){
 if(typeof PredictionRecoveryIntent==='undefined')return NO_RECOVERY_OVERLAY;
 return PredictionRecoveryIntent.readOverlay(env,Date.now());
}
async function predictionFreshness(env,profile){
 const recovery=await predictionRecoveryOverlay(env);
 const mode=PREDICTION_PROFILE_MODE,fingerprintMode=PREDICTION_FINGERPRINT_MODE,digest=profile?await profileLineageDigests(profile):null;
 // The combined verdict checks two kinds of approval: the registry's declarations and the profile lineage's; one digest lookup serves both.
 const registry=await fingerprintRegistryDigests(),transitionOptions=fingerprintEvaluatorOptions(text=>registry.lookup(text)??digest?.(text)??null),modes={fingerprint:fingerprintMode,prompt:fingerprintMode,profile:mode};
 // One verdict covers the fingerprint, the prediction prompt and the profile, and it decides.
 const verdict=(prediction,fingerprint,genres)=>predictionTransitionCompatibility(prediction,fingerprint,{genres},profile,FINGERPRINT_TRANSITIONS,fingerprintTarget(),modes,transitionOptions);
 const fingerprintVerdict=(fingerprint,genres)=>fingerprintCompatibility(fingerprint,{genres},FINGERPRINT_TRANSITIONS,fingerprintTarget(),fingerprintMode,transitionOptions);
 // `filmId` (optional) lets the recovery overlay deny that film's exact stored version; without it the ordinary rule alone answers.
 return {mode,fingerprintMode,needsGenres:true,registryDigest:registry.registry,target:fingerprintTarget(),recovery:{ready:recovery.ready,revision:recovery.revision,size:recovery.size},overlay:recovery,
  state:(prediction,fingerprint,genres,filmId)=>!!profile&&!!prediction&&!recovery.deniesPrediction(filmId,prediction)&&predictionCompatibilityFresh(verdict(prediction,fingerprint,genres)),
  indexed:(item,film)=>!!profile&&!!item?.prediction&&!recovery.deniesPrediction(film?.id==null?undefined:String(film.id),item.prediction)&&predictionCompatibilityFresh(verdict(item.prediction,indexedFingerprintRecord(item),film?.genres)),
  // The evaluator's own verdict for an indexed item ({outcome:'current'|'compatible'|'stale',reason}); the film page shows its reason, it never re-derives one from a version number.
  verdictOf:(item,film)=>profile&&item?.prediction?verdict(item.prediction,indexedFingerprintRecord(item),film?.genres):null,
  // The stored fingerprint may be reused for a prediction when it is exact or compatible under the transition rule.
  fingerprintUsable:(fingerprint,genres,filmId)=>!recovery.deniesFingerprint(filmId,fingerprint)&&fingerprintCompatibilityFresh(fingerprintVerdict(fingerprint,genres)),
  work:(prediction,fingerprint,genres)=>verdict(prediction,fingerprint,genres),
  fingerprintVerdict:(fingerprint,genres)=>fingerprintVerdict(fingerprint,genres)};
}
const strictFreshness=profile=>({mode:'strict',fingerprintMode:'strict',needsGenres:false,registryDigest:null,target:fingerprintTarget(),state:(prediction,fingerprint)=>predictionCurrent(prediction,profile,fingerprint),indexed:item=>!!profile&&indexedPredictionCurrent(item,profile),verdictOf:()=>null,fingerprintUsable:fingerprint=>fingerprintCurrent(fingerprint),work:()=>null,fingerprintVerdict:()=>null});
function indexedPredictionCurrent(item,profile){const p=item?.prediction;return !!p&&p.tasteProfileVersion===profile.version&&p.tasteProfileHash===profile.profileHash&&p.fingerprintHash===item.fingerprintHash&&p.fingerprintSchemaVersion===FINGERPRINT_SCHEMA_VERSION&&p.predictionPromptVersion===PREDICTION_PROMPT_VERSION;}
const PREDICTION_PIPELINE_VERSION=5;
const PREDICTION_MUTATION_LEASE=ENRICHMENT_KEY+'writer-lease.json';
function predictionPriority(film,now=Date.now()){
 const starts=(film.shows||[]).map(s=>s.start).filter(t=>Number.isFinite(t)&&t>=now-72*3600000&&t<now+24*3600000);
 if(!starts.length&&Number.isFinite(film.epgLastAiring)&&filmIsHot(film,now))starts.push(film.epgLastAiring);
 const hot=filmIsHot(film,now),availableNow=starts.some(t=>t<=now),today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid'}).format(now),availableToday=starts.some(t=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Madrid'}).format(t)===today),deadline=starts.length?Math.max(...starts)+72*3600000:null;
 return {hot,availableNow,availableToday,availableUntil:deadline?new Date(deadline).toISOString():null,rank:hot?(availableNow&&deadline-now<=24*3600000?0:1):2,expiresInMs:deadline?deadline-now:Infinity};
}
// The zero-quota test of `adaptivePredictionBatch`, usable on an empty queue (which answers `empty` first).
function capacityExhausted(capacity={}){return (Number.isFinite(capacity?.remainingPercent)&&Math.max(0,Math.min(100,capacity.remainingPercent))===0)||capacity?.quotaAvailable===false;}
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
 const text=String(value||'');if(['external_termination','retry_backoff','format_error_storm','model_unavailable','api_error','lease_lost','client_state_lost','manifest_unusable'].includes(text))return text;if(/quota|usage|limit/i.test(text))return 'quota';if(/time|deadline/i.test(text))return 'time_budget';if(/parse|json/i.test(text))return 'parse_error';if(/profile/i.test(text))return 'profile_changed';if(/lease|interrupt/i.test(text))return 'lease_expired';if(/storage|persist|checkpoint/i.test(text))return 'storage_error';if(/supersed|priority/i.test(text))return 'priority_changed';return text?'model_error':null;
}
const RUNNER_LEASE_KEY=ENRICHMENT_KEY+'runner-lease.json';
// AIR-588 (owner containment of 24 Nov 2026): 12 minutes, so a run that stops renewing after its start frees the runner before the next quarter-hour slot of the four Tasks
// (AIR-544 used the same value with five Tasks and was restored to 15 with them). A live lease is never re-dated: every expiry decision reads the stored `expiresAt`, so a lease
// written under 15 minutes keeps its expiry until its next write, which gives it 12.
const RUNNER_LEASE_TTL=12*60000;
// The answer of a refused acquire as it always was: without the holder's `heartbeatAt`, which the Worker keeps for its own age notes.
const leaseRefusalAnswer=answer=>{if(!answer||typeof answer!=='object')return answer;const {heartbeatAt,...rest}=answer;void heartbeatAt;return rest;};
// The age of a lease since its last write. Every acquire, renewal, gate and heartbeat write stamps `heartbeatAt`, which is exact whatever TTL wrote the lease (15 minutes before
// AIR-588's change, a 180 s claim or ready lease); a holder that carries only its expiry falls back to the expiry minus the current runner TTL.
function leaseAgeMs(holder,at=Date.now()){
 const beat=Date.parse(holder?.heartbeatAt||'');
 if(Number.isFinite(beat))return Math.round(at-beat);
 return Number.isFinite(holder?.expiresAt)?Math.round(at-(holder.expiresAt-RUNNER_LEASE_TTL)):NaN;
}
// ADR 0188: a keyed real start claims the runner lease before its heavy preflights. The claim is short and renewed at every stage boundary; it becomes the run's lease (same epoch) before the first persist side effect.
const START_CLAIM_TTL_MS=180000;
// ADR 0188: how long a same-key repeat waits for the owner request's stored start answer before it answers `start_pending`. Unproven by the traces; natural runs are the proof.
const JOIN_WAIT_MS=10000;
const INVOCATION_KEY_PATTERN=/^[A-Za-z0-9._:-]{16,128}$/;
// ADR 0193 (deferred start). The key a Task uses for a deferred start is issued by the server (`prediction_batch_key`), never composed by the model. A short lease covers a prepared run until its first
// heartbeat or submit: a caller that disappears after the receipt blocks the runner for minutes, not for the ordinary 15.
const DEFERRED_KEY_PATTERN=/^dk1\.[0-9a-f]{32}$/;
const READY_LEASE_TTL_MS=180000;
const START_OUTCOME_PREFIX=ENRICHMENT_KEY+'batch-start/';
// The run id of a deferred start is derived from the hash of its issued key, so a retry of the same invocation finds its attempt, its terminal outcome and its manifest without any index, and no new
// invocation can reuse it (fresh executions use fresh keys). The attempt marker is written once, only after the Workflow instance is known to exist.
const DEFERRED_RUN_PATTERN=/^dk-[0-9a-f]{32}$/;
const deferredRunIdOf=keyHash=>'dk-'+keyHash.slice(0,32);
const START_ATTEMPT_PREFIX=START_OUTCOME_PREFIX+'attempt/';
const START_POLL_MS=5000;
// ADR 0195 / AIR-573. The four standing Scheduled Tasks carry a fixed, non-secret `taskId` in their installed prompt (`task00`, `task15`, `task30`, `task45`). It is a logical owner label stored beside the run id
// and epoch of a run and its lease, never a security identity (Cloudflare Access and the JWT are unchanged) and never a replacement for the run id, the epoch or the compare-and-swap fencing.
const TASK_IDS=['task00','task15','task30','task45'];
const isTaskId=value=>typeof value==='string'&&TASK_IDS.includes(value);
const taskKeyHashOf=taskId=>contentHash({purpose:'iptv-batch-start-task',taskId});
// The answer carries no `status` field on purpose: `observedPrediction` records a stop for a `blocked` status, and a foreign call must never stop the owner's run.
// `taskOwnerGate` runs the same refusal BEFORE the step recorder and the writer lease for heartbeat and complete, so a foreign call writes nothing at all (no diagnostics step, no writer lease); the handlers repeat it under the writer.
const taskOwnerGate=async(env,body,work)=>{
 if(isObject(body)&&typeof body.runId==='string'&&body.runId.length<=100){
  const run=await checkedRun(env,body.runId);
  const refused=run?taskOwnerRefusal(run.taskId,body.taskId,run.runId):(body.taskId!==undefined&&!isTaskId(body.taskId)?taskOwnerRefusal(null,body.taskId,null):null);
  if(refused)return refused;
 }
 return work();
};
// A run-scoped call must come from the owner label of its run: a run started by a Task is operated only by that Task (a caller without a label is refused too); a run without a label is operated only by a caller without one.
// A foreign or missing label is refused before any write and the answer never names the owner or carries a payload of the run.
const taskOwnerRefusal=(owner,caller,runId)=>{
 if(caller!==undefined&&!isTaskId(caller))return json({error:'Invalid taskId',code:'invalid_task_id'},400);
 // Presence must match and the values must be equal: a labelled run is operated only by its own label, and a run without a label (manual, keyless, keyed or deferred start) only by a caller without one, as before.
 // A Task can therefore neither operate nor read a label-free run, whatever runId and epoch it knows.
 if((owner??null)===(caller??null))return null;
 return json({error:'wrong_owner',code:'wrong_owner',reason:'wrong_owner',runId:isText(runId,100)?runId:null,...scheduledRunFields()},409);
};
// While a deferred run is still being prepared (`prep`) the claim, the persist gate and every renewal made by the preparation hold the short lease; only a renewal by the client (a heartbeat,
// `clientAckAt`) restores the full TTL. A start without `prep` (ordinary, keyless, synchronous keyed) is unchanged.
const leaseTtlOf=old=>old?.prep&&!old?.clientAckAt?READY_LEASE_TTL_MS:RUNNER_LEASE_TTL;
// The correlation fields of a lease: they survive every renewal, heartbeat, gate write and conversion, and only a release drops them (ADR 0188 section 3).
const leaseCorrelation=old=>{const out={};if(old?.phase)out.phase=old.phase;if(old?.keyHash)out.keyHash=old.keyHash;if(old?.taskId)out.taskId=old.taskId;if(old?.argsHash)out.argsHash=old.argsHash;if(old?.clientSubmitAt)out.clientSubmitAt=old.clientSubmitAt;if(old?.deferred)out.deferred=true;if(old?.prep)out.prep=true;if(old?.clientAckAt)out.clientAckAt=old.clientAckAt;return out;};
// The lease value carries `epoch`, the ownership epoch of batch runner v2 (ADR 0122): set once when a run acquires or takes over the lease and kept by every
// renewal, heartbeat, checkpoint and release, so the next acquire increments it. It is never the CAS revision (the D1 row token or the object etag), which
// changes on every write and stays inside the Worker. A renewal that loses the compare-and-swap to another write of the same lease is read again and retried a
// bounded number of times; it becomes `lease_lost` only when the lease read afterwards names another holder, or has expired.
const RUNNER_LEASE_ATTEMPTS=3;
const previousEpochOf=lease=>Number.isInteger(lease?.epoch)&&lease.epoch>=0?lease.epoch:null;
async function runnerLease(env,runId,operation='renew',claim=null,expectEpoch=null){
 let epochSeen=null;
 for(let attempt=1;;attempt++){
  const head=typeof PredictionD1==='undefined'?null:await PredictionD1.openLease(env,RUNNER_LEASE_KEY),object=head?head.object:await env.BUCKET.get(RUNNER_LEASE_KEY),old=head?head.value:(object?await object.json():null),now=Date.now();
  // `heartbeatAt` (the holder's last write) is carried for the refusal's own age note only (leaseAgeMs) and stripped from every answer (leaseRefusalAnswer).
  if(operation==='acquire'&&old?.expiresAt>now)return {status:'already_running',runId:old.runId,expiresAt:old.expiresAt,...(typeof old.heartbeatAt==='string'?{heartbeatAt:old.heartbeatAt}:{})};
  if(operation!=='acquire'&&(!old||old.runId!==runId||old.expiresAt<=now))return {status:'lease_lost',runId:old?.runId||null};
  // A release that names its epoch never touches the lease of another epoch of the same run id (a deferred run id is derived from its key).
  if(operation==='release'&&expectEpoch!==null&&previousEpochOf(old)!==expectEpoch)return {status:'lease_lost',runId:old?.runId||null,reason:'epoch'};
  const previousEpoch=previousEpochOf(old),epoch=operation==='acquire'?(previousEpoch??0)+1:previousEpoch;epochSeen=previousEpoch;
  const value={owner:runId,runId,heartbeatAt:new Date(now).toISOString(),expiresAt:operation==='release'?0:now+(operation==='acquire'&&claim?START_CLAIM_TTL_MS:RUNNER_LEASE_TTL),...(epoch!==null?{epoch}:{}),...(operation!=='acquire'&&old?.submitGate?{submitGate:old.submitGate}:{}),...(operation==='acquire'&&claim?{phase:'claim',keyHash:claim.keyHash,argsHash:claim.argsHash,...(claim.taskId?{taskId:claim.taskId}:{}),...(claim.deferred?{deferred:true,prep:true}:{})}:operation==='renew'?{...leaseCorrelation(old),clientAckAt:new Date(now).toISOString()}:{})};
  const saved=head?await PredictionD1.writeLease(env,head,value):await env.BUCKET.put(RUNNER_LEASE_KEY,JSON.stringify(value),{onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});
  if(saved===null){
   if(operation!=='acquire'&&attempt<RUNNER_LEASE_ATTEMPTS)continue;
   const current=await loadJSON(env,RUNNER_LEASE_KEY);
   if(operation==='acquire')return {status:'already_running',runId:current?.runId||null};
   // The lease is still this run's and alive: the compare-and-swap lost to another write of it (a heartbeat or a checkpoint of the same owner), which is not a loss of ownership.
   // The caller gets an explicit retryable answer, never `lease_lost`.
   if(current?.runId===runId&&current.expiresAt>Date.now()&&(previousEpochOf(current)===null||previousEpochOf(current)===epochSeen))return {status:'busy',reason:'lease_contention',runId};
   return {status:'lease_lost',runId:current?.runId||null};
  }
  return {status:'owned',...value,...(operation==='acquire'&&old?.runId&&old.expiresAt<=now?{recoveredRunId:old.runId}:{})};
 }
}
async function runnerHeartbeat(env,body){
 const run=await checkedRun(env,body?.runId);if(!run||run.status!=='running')return json({error:'Unknown or completed run'},409);
 {const foreign=taskOwnerRefusal(run.taskId,body.taskId,run.runId);if(foreign)return foreign;}
 const lease=await runnerLease(env,run.runId);if(lease.status!=='owned')return json(lease,409);
 // A batch v2 run belongs to one ownership epoch; a lease of another epoch is not this run's (ADR 0122).
 if(run.protocol===BATCH_PROTOCOL&&Number.isInteger(run.epoch)&&lease.epoch!==run.epoch)return json({status:'lease_lost',runId:run.runId},409);
 run.lastHeartbeatAt=lease.heartbeatAt;await savePredictionRun(env,run);await runnerProgress(env,run,await loadJSON(env,predictionQueueKey));return json({...runSummary(run),expiresAt:lease.expiresAt,...(run.protocol===BATCH_PROTOCOL?{epoch:lease.epoch}:{})});
}
// The progress Event of a run and the counters that say it was emitted, or null when it is not due. v5 writes the Event and then saves the run; batch runner v2 saves the run first,
// with the Event as an intent, and writes the Event after that authoritative checkpoint (batchProgress).
async function predictionProgressEvent(env,run,queue,final=false){
 const summary=runSummary(run),success=summary.added+summary.updated,now=Date.now();
 run.hotRemaining=queue?.priorityCount??0;run.coldRemaining=queue?.coldRemaining??0;
 if(isBatchV2Run(run)&&!final)return null;
 if(!final&&success-(run.progressSavedCount||0)<50&&now-Date.parse(run.lastProgressAt||run.createdAt)<30*60000)return null;
 const at=new Date(now).toISOString(),snapshot=await predictionEventSnapshot(env,queue,run.batchSize),delta=predictionEventDelta(run,summary,snapshot);run.progressSavedCount=success;run.lastProgressAt=at;
 return {id:'enrichment-'+run.runId+(final?'':'-progress-'+success),type:'enrichment',at,stage:final?run.status:'running',runId:run.runId,trigger:run.trigger,added:summary.added,updated:summary.updated,failed:summary.failed,batchCount:summary.batchCount,batchesProcessed:predictionBatchesProcessed(run),remaining:run.hotRemaining+run.coldRemaining,hotRemaining:run.hotRemaining,coldRemaining:run.coldRemaining,queueSchemaVersion:6,delta,snapshot,reason:run.stopReason||null,...batchV2EventFields(run),...scheduledRunFields()};
}
async function runnerProgress(env,run,queue,final=false){
 const event=await predictionProgressEvent(env,run,queue,final);if(!event)return;
 await writeEvent(env,event);
 await savePredictionRun(env,run);
}
// ---- AIR-553 / ADR 0194 (Accepted): the batch_v2 auxiliary state (held stage, run sources, persisted manifest, event outbox) in D1, behind its OWN marker `prediction_aux_authority`. ----
// DORMANT: while the marker is `r2` (or the schema is older than migration 0034) `auxAuthority` answers null and every function below keeps its R2 code unchanged. When the marker is `d1` the four
// families are served from D1 only: an unavailable authority throws (never a read of the R2 object). The Events journal (`events/items/*`) and the deferred-start receipts stay R2.
const WRITER_OWNER=Symbol.for('iptv.prediction.writerOwner');
// Worker modules never name the database binding; the auxiliary-state module owns it (tests/d1-backfill.mjs).
const auxDb=env=>PredictionAux.databaseOf(env);
// The fence class of an outbox write is explicit: the writer lease the caller holds (owner threaded from `predictionWriter`), else the target row's own state.
const auxFence=env=>({writer:env?.[WRITER_OWNER]||null,fence:env?.[WRITER_OWNER]?'writer':'target'});
async function auxAuthority(env){
 if(typeof PredictionAux==='undefined'||typeof PredictionD1==='undefined')return null;
 const base=await PredictionD1.readPredictionAuthority(env?.DB??null,env);
 if(base.mode!=='d1')return null;
 return PredictionAux.auxD1(auxDb(env),env,{version:base.version});
}
// ---- ADR 0196 (amends ADR 0194 decision 1): the admission gate of the cutover. While the marker reads `closed` NO request of any origin (Task, manual MCP or HTTP, Workflow step, the lease-free skipped, delivery
// and acknowledgement paths) may write one of the four R2 families, and the routes that would make one answer a typed refusal before they start. `closed` is not an authority and not unavailable: reads keep
// serving the R2 objects, which stay the data until d1. The gate is the bucket the request holds: every put or delete of a key of those families first reads the marker FRESH (never the request scope), so a
// request that read r2 at its start still refuses at its own write. What it cannot do is recall a PUT already past that read: that residual is one object-store operation, bounded by the drain wait of the
// cutover plan, never "none". ----
const AUX_BUCKET_GUARDED=Symbol.for('iptv.prediction.auxGuardedBucket');
const auxR2Family=key=>typeof key==='string'&&(key===BATCH_STAGE_KEY||key===EVENT_OUTBOX_KEY||key.startsWith(ENRICHMENT_KEY+'sources/')||key.startsWith(ENRICHMENT_KEY+'batch-manifest/')||key.startsWith(START_EVENT_PREFIX)||key.startsWith(STOP_EVENT_PREFIX));
async function auxR2WriteGate(env,keys){
 if(!(Array.isArray(keys)?keys:[keys]).some(auxR2Family))return;
 if(typeof PredictionAux==='undefined')return;
 // The proof is read AT the PUT, from the database, and nothing from the request scope is used: not the marker, not the schema version (a request that read schema 33 at its start must not carry that
 // negative proof across the apply of 0034 and a close; review of PR 893). Before 0034 the guard is one `schema_contract` read, once installed two; the cost is stated in ADR 0196.
 await PredictionAux.guardR2Write(auxDb(env),env);
}
function auxGuardedEnv(env){
 if(!env?.BUCKET||typeof PredictionAux==='undefined'||typeof PredictionD1==='undefined'||env.BUCKET[AUX_BUCKET_GUARDED])return env;
 const bucket=env.BUCKET;
 const guarded=new Proxy(bucket,{get(target,prop){
  if(prop===AUX_BUCKET_GUARDED)return true;
  const value=target[prop];
  if(typeof value!=='function')return value;
  if(prop==='put')return async(key,...rest)=>{await auxR2WriteGate(env,key);return bucket.put(key,...rest);};
  if(prop==='delete')return async keys=>{await auxR2WriteGate(env,keys);return bucket.delete(keys);};
  return value.bind(target);
 }});
 return {...env,BUCKET:guarded};
}
// The typed refusal of a route that would write one of the families. null when the marker is not closed (r2, d1, not installed); an unavailable marker throws as it does for every aux read.
async function auxClosedRefusal(env){
 if(typeof PredictionAux==='undefined'||typeof PredictionD1==='undefined')return null;
 const base=await PredictionD1.readPredictionAuthority(env?.DB??null,env);
 if(base.mode!=='d1')return null;
 const authority=await PredictionAux.readAuxAuthority(auxDb(env),env,{version:base.version});
 if(!PredictionAux.auxClosed(authority))return null;
 return json({status:'blocked',error:'The prediction auxiliary state is closed for a cutover',code:'prediction_aux_closed',reason:'prediction_aux_closed',retryable:false},503,{'Retry-After':'60'});
}
const AUX_SOURCE_KEY=/^enrichment\/sources\/([A-Za-z0-9_-]{1,100})\.json$/,AUX_MANIFEST_KEY=/^enrichment\/batch-manifest\/([A-Za-z0-9_-]{1,100})\.json$/;
const auxKeyKind=key=>typeof key!=='string'?null:key===ENRICHMENT_KEY+'batch-stage.json'?'stage':AUX_SOURCE_KEY.test(key)?'source':AUX_MANIFEST_KEY.test(key)?'manifest':null;
const auxGuardOf=env=>env?.[BATCH_COMMIT_GUARD]||null;
async function auxRouteRead(env,key){
 const kind=auxKeyKind(key);if(!kind)return {handled:false};
 const aux=await auxAuthority(env);if(!aux)return {handled:false};
 if(kind==='stage'){const stage=await PredictionAux.readStage(auxDb(env));return {handled:true,value:{items:stage.items,updatedAt:stage.updatedAt}};}
 if(kind==='source'){const got=await PredictionAux.readSource(auxDb(env),AUX_SOURCE_KEY.exec(key)[1]);return {handled:true,value:got?got.value:null};}
 return {handled:true,value:await PredictionAux.readManifest(auxDb(env),AUX_MANIFEST_KEY.exec(key)[1])};
}
async function auxRouteWrite(env,key,value){
 const kind=auxKeyKind(key);if(!kind)return {handled:false};
 const aux=await auxAuthority(env);if(!aux)return {handled:false};
 const options={guard:auxGuardOf(env),writer:env?.[WRITER_OWNER]||null};
 if(kind==='source')await PredictionAux.writeSource(auxDb(env),aux,AUX_SOURCE_KEY.exec(key)[1],value,{...options,create:options.guard?.create===true});
 else if(kind==='manifest')await PredictionAux.writeManifest(auxDb(env),aux,AUX_MANIFEST_KEY.exec(key)[1],value,options);
 else throw new Error('prediction_aux_stage_write_route');
 return {handled:true};
}
const auxJournalKey=event=>removalEventKey(event);
// One delivery of an outbox row: the journal write (idempotent, keyed by the event id and the original `at`), then `delivered`, only after the journal answered. Three attempts, as before.
async function auxFlushRow(env,aux,row){
 if(!row)return false;
 if(row.compacted||row.state==='delivered'||row.state==='superseded')return true;
 for(let attempt=0;attempt<3;attempt++){
  try{await writeEvent(env,row.event);await PredictionAux.settleOutbox(auxDb(env),aux,row.eventKey,'delivered',auxFence(env));return true;}catch{/* tried again */}
 }
 return false;
}
async function auxPark(env,aux,kind,identity,event,runId){
 const out=await PredictionAux.admitOutbox(auxDb(env),aux,{kind,identity,event,journalKey:auxJournalKey(event),runId,...auxFence(env)});
 return out.row;
}
// The legacy record shape of a stop row (`{event, delivered, superseded}`): a settled row whose payload was compacted never rebuilds an Event, the run keeps its own.
const auxStopRecord=(row,run)=>row?{event:row.event||run?.event||null,delivered:row.state==='delivered'||row.state==='superseded',superseded:row.state==='superseded',row}:null;
async function auxDeliverPending(env,aux,now=Date.now()){
 const report={checked:0,delivered:0,failed:0,quarantined:0};
 try{
  const latest=await loadJSON(env,ENRICHMENT_KEY+'latest-run.json');
  // A batch_v2 stop whose record was never parked (the process ended between the run record and the park) is admitted from the run's own event; an existing identity is a no-op.
  if(isBatchV2Run(latest)&&isText(latest?.runId,100)&&latest.event&&['complete','partial'].includes(latest.status))await auxPark(env,aux,'stop',latest.runId,latest.event,latest.runId);
  const snapshot=await PredictionAux.drainSnapshot(auxDb(env),{runId:isText(latest?.runId,100)?latest.runId:null,limit:PredictionAux.AUX_LIMITS.drainLimit});
  for(const row of snapshot.pending){
   report.checked++;let result='failed';
   try{
    if(row.kind==='stop'&&row.event&&!(row.event.presentation===BATCH_V2_SKIPPED||row.event.stage==='complete')){const stop=await recordRunStop(env,row.event.runId,row.event.reason,{outbox:true});result=stop.status==='superseded'||stop.eventPending===false?'delivered':'failed';}
    else result=await auxFlushRow(env,aux,row)?'delivered':'failed';
   }catch{}
   if(result==='delivered')report.delivered++;
   else{report.failed++;try{if(await PredictionAux.failOutbox(auxDb(env),aux,row,auxFence(env))==='quarantined')report.quarantined++;}catch{/* the next start counts it */}}
  }
  if(snapshot.compactable.length){try{await PredictionAux.compactSettled(auxDb(env),aux,{keys:snapshot.compactable});}catch{/* compaction is retried by the next start; it never blocks a delivery */}}
 }catch{report.failed++;}
 if(report.checked||report.failed||report.quarantined)logEventOutbox(report);
 return report;
}
async function auxRecordSkipped(env,aux,{requestId,body,holder,reason,cause}){
 try{
  const id=safeRequestId(requestId)||crypto.randomUUID();
  const event=skippedStartEvent({requestId:id,body,holder,reason,cause,at:new Date().toISOString()});
  const out=await PredictionAux.admitOutbox(auxDb(env),aux,{kind:'skipped',identity:id,event,journalKey:auxJournalKey(event),fence:'target'});
  if(out.refused==='cap'){logEventOutbox({skippedCapRefused:1});return false;}
  return await auxFlushRow(env,aux,out.row);
 }catch{return false;}
}
const START_EVENT_PREFIX=ENRICHMENT_KEY+'start-events/';
// The batch start's checkpoint of the coverage it began from. v2 writes no start Event (ADR 0146); the start Events of the retired v5 runner stay deliverable from START_EVENT_PREFIX.
async function runnerStarted(env,run,queue,inputs=null){
 const snapshot=await predictionEventSnapshot(env,queue,run.batchSize,inputs);
 run.coverageStartCurrentPredictions=snapshot.coverage?.currentPredictionsTotal??null;await savePredictionRun(env,run);
}
const STOP_EVENT_PREFIX=ENRICHMENT_KEY+'stop-events/';
function systemicReason(reason){
 const text=String(reason||'');if(['quota','model_unavailable','api_error','storage_error','lease_lost','format_error_storm','profile_changed','lease_expired','external_termination','model_error','runner_aborted','time_budget','priority_changed','client_state_lost','manifest_unusable'].includes(text))return text;
 if(/quota|usage|limit/i.test(text))return 'quota';if(/lease/i.test(text))return 'lease_lost';if(/profile|model/i.test(text))return 'model_unavailable';return 'storage_error';
}
async function flushStopEvent(env,record,key){
 if(record.delivered)return true;
 for(let attempt=0;attempt<3;attempt++){try{await writeEvent(env,record.event);if(key){record.delivered=true;await saveJSON(env,key,record);}return true;}catch{}}
 return false;
}
async function parkAndFlushRunEvent(env,event,runId){
 if(!event||!runId)return false;
 const aux=await auxAuthority(env);
 if(aux){try{return await auxFlushRow(env,aux,await auxPark(env,aux,'stop',runId,event,runId));}catch{return false;}}
 const key=STOP_EVENT_PREFIX+runId+'.json';
 try{
  let record=await loadJSON(env,key);
  if(!record){record={event};const saved=await env.BUCKET.put(key,JSON.stringify(record),{onlyIf:{etagDoesNotMatch:'*'}});if(saved===null)record=await loadJSON(env,key)||record;}
  const written=await flushStopEvent(env,record,key);if(!written)await noteEventOutbox(env,key);return written;
 }catch{return false;}
}
async function reconstructMissingBatchV2StopRecord(env,latest,pending){
 if(!isBatchV2Run(latest)||!isText(latest?.runId,100)||!latest.event||!['complete','partial'].includes(latest.status))return;
 const key=STOP_EVENT_PREFIX+latest.runId+'.json';
 if(pending[key]?.quarantined)return;
 try{if(await loadJSON(env,key))return;await env.BUCKET.put(key,JSON.stringify({event:latest.event}),{onlyIf:{etagDoesNotMatch:'*'}});}catch{}
}
async function recordRunStop(env,id,reason,fallback={}){
 const aux=await auxAuthority(env);
 let run=await checkedRun(env,id)||{runId:id,mode:'queued',trigger:fallback.trigger==='scheduled'?'scheduled':'manual',createdAt:new Date().toISOString(),selectedIds:[],results:{},failures:{}};
 if(fallback.protocol===BATCH_PROTOCOL&&run.protocol!==BATCH_PROTOCOL)run.protocol=BATCH_PROTOCOL;
 if(run.recoveredByRunId){if(aux){const row=await PredictionAux.readOutboxRow(auxDb(env),PredictionAux.outboxKey('stop',id));if(row&&(row.state==='pending'||row.state==='quarantined'))await PredictionAux.settleOutbox(auxDb(env),aux,row.eventKey,'superseded',{...auxFence(env),supersededRun:id});}else{const pending=await loadJSON(env,STOP_EVENT_PREFIX+id+'.json');if(pending&&!pending.delivered)await saveJSON(env,STOP_EVENT_PREFIX+id+'.json',{...pending,delivered:true,superseded:true});}return {status:'superseded',runId:id,continuedByRunId:run.recoveredByRunId,mustComplete:false};}
 const settled=await settleRunRetries(env,run,'stop_retries'),key=STOP_EVENT_PREFIX+id+'.json',existing=aux?auxStopRecord(await PredictionAux.readOutboxRow(auxDb(env),PredictionAux.outboxKey('stop',id)),run):await loadJSON(env,key);let record=existing;
 if(!record){let queue=null;try{queue=await loadJSON(env,predictionQueueKey);}catch{}const summary=runSummary(run),at=run.event?.at||run.completedAt||new Date().toISOString();
 const snapshot=await predictionEventSnapshot(env,queue,run.batchSize),delta=predictionEventDelta(run,summary,snapshot),v2=batchV2EventFields(run);
 let sources=null;try{sources=await loadJSON(env,ENRICHMENT_KEY+'sources/'+id+'.json');}catch{}
 applyRetrySnapshot(run,queue);
 const states=isBatchV2Run(run)?await Promise.all((run.selectedIds||[]).map(fid=>readFilmState(env,fid))):[];
 await recoverBatchEventFilms(env,run,sources||{},states);
 const event=withBatchV2EventDetails({remaining:queue?(queue.priorityCount||0)+(queue.coldRemaining||0):null,id:run.event?.id||'enrichment-'+id,type:'enrichment',runId:id,at,queueSchemaVersion:6,stage:'partial',title:v2.presentation?'Пакет прогнозов прерван':'Прогнозы приостановлены',reason:systemicReason(reason),stopReason:systemicReason(reason),trigger:run.trigger,added:summary.added,updated:summary.updated,failed:summary.failed,checked:summary.checked,processed:summary.processed,hotProcessed:summary.hotProcessed,coldProcessed:summary.coldProcessed,batchCount:summary.batchCount,batchesProcessed:predictionBatchesProcessed(run),hotRemaining:queue?.priorityCount??fallback.hotRemaining??run.hotRemaining??null,coldRemaining:queue?.coldRemaining??fallback.coldRemaining??run.coldRemaining??null,delta,snapshot,...v2},run,sources);
 // ADR 0194 decisions 2 and 6: with the outbox in D1 the terminal Event's identity is NOT parked first; it commits in the SAME batch as the run's terminal transition below (plus the compare-and-swap that
 // the run was not recovered by a successor meanwhile), so a run is never terminal without its durable outbox row. The journal delivery follows and is retried independently.
 if(aux)record={event,admission:await PredictionAux.outboxAdmission(aux,{kind:'stop',identity:id,event,journalKey:auxJournalKey(event),runId:id,writer:env?.[WRITER_OWNER]||null})};
 else{record={event};const saved=await env.BUCKET.put(key,JSON.stringify(record),{onlyIf:{etagDoesNotMatch:'*'}});if(saved===null)record=await loadJSON(env,key);}
 }
 run.status='partial';run.reason=record.event.reason;run.stopReason=record.event.reason;run.completedAt=record.event.at;run.event=record.event;run.counts={created:record.event.added,recalculated:record.event.updated,failed:record.event.failed,pending:(record.event.hotRemaining||0)+(record.event.coldRemaining||0)};
 if(fallback.callerFault&&!run.callerFault)run.callerFault=fallback.callerFault;
 if(aux){
  try{await saveJSON({...env,[COMMIT_EXTRA_KEY]:{runId:id,pre:[PredictionAux.runNotSupersededGuard(id)],statements:record.admission?.statements||[]}},runKey(id),run);}
  catch(error){
   // The CAS refused: a successor recovered this run meanwhile. The decision is made against the run's own row now, not against the earlier read.
   if(error?.code==='prediction_aux_cas'||error?.code==='prediction_domain_cas'){const fresh=await checkedRun(env,id);if(fresh?.recoveredByRunId){const row=await PredictionAux.readOutboxRow(auxDb(env),PredictionAux.outboxKey('stop',id));if(row&&(row.state==='pending'||row.state==='quarantined'))await PredictionAux.settleOutbox(auxDb(env),aux,row.eventKey,'superseded',{...auxFence(env),supersededRun:id});return {status:'superseded',runId:id,continuedByRunId:fresh.recoveredByRunId,mustComplete:false};}}
   throw error;
  }
  if(record.admission)record=auxStopRecord(await PredictionAux.readOutboxRow(auxDb(env),record.admission.eventKey),run);
 }else await saveJSON(env,runKey(id),run);
 await diagnosticCheckpoint(env,run);const latest=await loadJSON(env,ENRICHMENT_KEY+'latest-run.json');if(!latest||latest.runId===id||fallback.start)await saveJSON(env,ENRICHMENT_KEY+'latest-run.json',run);
 const written=aux?await auxFlushRow(env,aux,record.row):await flushStopEvent(env,record,key);if(!written&&!aux&&!fallback.outbox)await noteEventOutbox(env,key);await runnerLease(env,id,'release');return {...record.event,status:'partial',mustComplete:true,eventPending:!written,counts:run.counts,...(settled?{}:{retryHeal:'pending'})};
}
// AIR-416 (ADR 0107): delivery of a run's start and stop events to the Events Log belongs to the Predictions writer, never to a read. The durable record of an
// event is its `start-events/` or `stop-events/` object (`delivered` says whether the journal has it); the journal key is derived from the event's id and time,
// so a repeated delivery rewrites the same item and cannot duplicate it. `deliverPendingEvents` runs inside the writer lease of an authorized prediction start:
// it looks at the records of the latest run (an interrupted delivery leaves them undelivered) and at the small outbox index of earlier failures, delivers what
// is undelivered, and keeps what still fails in the index with an attempt count. After EVENT_OUTBOX_ATTEMPTS failures an entry is quarantined: it is no longer
// retried, stays visible in the status read, and its record is kept. Nothing here lists a prefix, so the cost of a start does not grow with history.
const EVENT_OUTBOX_KEY=ENRICHMENT_KEY+'event-outbox.json',EVENT_OUTBOX_LIMIT=20,EVENT_OUTBOX_ATTEMPTS=8;
const eventOutboxKey=key=>typeof key==='string'&&key.length<=200&&(key.startsWith(STOP_EVENT_PREFIX)||key.startsWith(START_EVENT_PREFIX))&&key.endsWith('.json');
function logEventOutbox(fields){try{console.log(JSON.stringify({event:'prediction_event_outbox',...fields}));}catch{}}
// Records one failed delivery at the moment it fails, so the next start retries it even when a newer run has become the latest one by then.
async function noteEventOutbox(env,key,now=Date.now()){
 if(!eventOutboxKey(key))return false;
 try{await mergeStoredJSON(env,EVENT_OUTBOX_KEY,{pending:{}},index=>{const pending=isObject(index?.pending)?index.pending:{};if(pending[key])return null;return {pending:{...pending,[key]:{since:new Date(now).toISOString(),attempts:0,lastAttemptAt:null,quarantined:false}},updatedAt:new Date(now).toISOString()};});return true;}catch{return false;}
}
async function deliverPendingEvents(env,now=Date.now()){
 {const aux=await auxAuthority(env);if(aux)return auxDeliverPending(env,aux,now);}
 const report={checked:0,delivered:0,failed:0,quarantined:0};
 try{
  const [index,latest]=await Promise.all([loadJSON(env,EVENT_OUTBOX_KEY),loadJSON(env,ENRICHMENT_KEY+'latest-run.json')]);
  const pending=isObject(index?.pending)?index.pending:{},indexed=Object.keys(pending).filter(eventOutboxKey);
  await reconstructMissingBatchV2StopRecord(env,latest,pending);
  // Quarantined entries stay in the index and in the status read; they are counted here and never take a delivery slot, so any number of them cannot keep a
  // later event from being delivered. The budget of one start goes, in this order, to the two records of the latest run (not yet noted anywhere when a
  // process ended between the record and the journal), then to the pending index entries, oldest first.
  report.quarantined=indexed.filter(key=>pending[key]?.quarantined).length;
  const latestKeys=isText(latest?.runId,100)?[START_EVENT_PREFIX+latest.runId+'.json',STOP_EVENT_PREFIX+latest.runId+'.json'].filter(key=>!pending[key]?.quarantined):[];
  const waiting=indexed.filter(key=>!pending[key]?.quarantined&&!latestKeys.includes(key)).sort((a,b)=>String(pending[a]?.since||'').localeCompare(String(pending[b]?.since||''))||a.localeCompare(b));
  const outcome={};
  for(const key of [...latestKeys,...waiting].slice(0,EVENT_OUTBOX_LIMIT)){
   let result='failed';
   try{
    const record=await loadJSON(env,key);
    if(!record?.event)result='absent';
    else if(record.delivered)result='delivered';
    else{
     report.checked++;
     // A stop is completed as a whole (run record, diagnostic row, journal item): the same idempotent path the stop itself took.
     if(key.startsWith(STOP_EVENT_PREFIX)){
      if(record.event.presentation===BATCH_V2_SKIPPED||record.event.stage==='complete')result=await flushStopEvent(env,record,key)?'delivered':'failed';
      else{const stop=await recordRunStop(env,record.event.runId,record.event.reason,{outbox:true});result=stop.status==='superseded'||stop.eventPending===false?'delivered':'failed';}
     }
     else result=await flushStopEvent(env,record,key)?'delivered':'failed';
     if(result==='delivered')report.delivered++;
    }
   }catch{}
   if(result==='failed')report.failed++;
   outcome[key]=result;
  }
  // The index changes only when an entry leaves it or a delivery failed; a start with nothing pending writes nothing here.
  const changed=Object.keys(outcome).some(key=>outcome[key]==='failed'||pending[key]);
  if(changed)await mergeStoredJSON(env,EVENT_OUTBOX_KEY,{pending:{}},stored=>{
   const next={...(isObject(stored?.pending)?stored.pending:{})};
   for(const [key,result] of Object.entries(outcome)){
    if(result!=='failed'){delete next[key];continue;}
    const attempts=(Number.isInteger(next[key]?.attempts)?next[key].attempts:0)+1;
    next[key]={since:next[key]?.since||new Date(now).toISOString(),attempts,lastAttemptAt:new Date(now).toISOString(),quarantined:attempts>=EVENT_OUTBOX_ATTEMPTS};
    if(next[key].quarantined)report.quarantined++;
   }
   return {pending:next,updatedAt:new Date(now).toISOString()};
  });
 }catch{report.failed++;}
 if(report.checked||report.failed||report.quarantined)logEventOutbox(report);
 return report;
}
// AIR-548 (ADR 0180): a real `batch_start` that a live runner lease turns away leaves ONE neutral Event of the refused request, `presentation: "batch_v2_skipped"`. It is not a run: no runId of its own, no
// counts, no lease, queue or film is touched for it. Its identity is the request's `X-Request-Id` (the id is stable under replay and different for another request, so no two requests are merged by time or
// guess), and it is parked create-only in `enrichment/stop-events/skipped-<requestId>.json`, so a repeated write reads the first record back (same `at`, same journal key) and a failed journal write is retried
// by the existing outbox. Best-effort by construction: it never throws and never changes the `already_running` answer. `already_running` and (AIR-575, ADR 0190) `catalog_held` are recorded; `409` refusals, `noop` and the rest are not.
const BATCH_V2_SKIPPED='batch_v2_skipped';
const SKIPPED_EVENT_PREFIX=STOP_EVENT_PREFIX+'skipped-';
// AIR-575 (ADR 0190): the same neutral Event also records a real start the Worker refused with `prediction_catalog_held` (`reason: "catalog_held"`, `cause` the Discovery code that refused the read). It has no holder.
function skippedStartEvent({requestId,body,holder,at,reason='already_running',cause=null}){
 const held=reason==='catalog_held';
 const event={id:'enrichment-skipped-'+requestId,type:'enrichment',at,stage:'skipped',protocol:BATCH_PROTOCOL,presentation:BATCH_V2_SKIPPED,reason:held?'catalog_held':'already_running',requestId};
 if(held&&CATALOG_HELD_CODES.includes(cause))event.cause=cause;
 if(body?.trigger==='scheduled'||body?.trigger==='manual')event.trigger=body.trigger;
 if(held)return event;
 if(isText(holder?.runId,100)&&SAFE_LOG_ID.test(holder.runId))event.holderRunId=holder.runId;
 if(holder){const age=leaseAgeMs(holder,Date.parse(at));if(Number.isFinite(age)&&age>=0&&age<=7*86400000)event.holderAgeMs=age;}
 return event;
}
// Removes one delivered entry from the outbox index at once (best effort: an entry that stays is removed by the next sweep, which finds its record delivered).
async function clearEventOutbox(env,key){
 try{await mergeStoredJSON(env,EVENT_OUTBOX_KEY,{pending:{}},index=>{const pending=isObject(index?.pending)?index.pending:{};if(!pending[key])return null;const next={...pending};delete next[key];return {pending:next,updatedAt:new Date().toISOString()};});}catch{/* the next sweep settles it */}
}
// Order is the guarantee (review of PR #805): the outbox index entry is written BEFORE the record is parked, so a parked record never exists without an entry that finds it and a failure of both the
// journal and the index cannot orphan a stored record. The parked record is also the request's idempotency identity (it holds `at`, which is part of the journal key): no journal item is ever written for
// a request whose record is not parked, and a record whose journal outcome is not KNOWN to be absent is never deleted, so a replay of one request id always reuses the same `at` and can never create a second
// item. The journal write and the `delivered` marker are separate steps: a journal item that exists counts as delivered even when the marker cannot be written (the next sweep or a replay rewrites the same
// item and marks it). If the index cannot be written the record is parked and delivered once; it is deleted again only when a `head` of the journal key proves the item absent. An unknown outcome
// (the head fails too) keeps the record, which is replay-safe. The Event is lost only when the journal AND the index are both down (a stated limitation, ADR 0180). A park that fails after the index entry writes
// nothing: the entry, whose record is `absent`, leaves the index at the next sweep.
async function recordSkippedStart(env,{requestId,body,holder,reason,cause}){
 try{
  const aux=await auxAuthority(env);
  if(aux)return await auxRecordSkipped(env,aux,{requestId,body,holder,reason,cause});
 }catch{return false;}
 try{
  const id=safeRequestId(requestId)||crypto.randomUUID(),key=SKIPPED_EVENT_PREFIX+id+'.json';
  let record=await loadJSON(env,key);
  if(record?.delivered)return true;
  const indexed=await noteEventOutbox(env,key),created=!record;
  if(!record){
   record={event:skippedStartEvent({requestId:id,body,holder,reason,cause,at:new Date().toISOString()})};
   try{const saved=await env.BUCKET.put(key,JSON.stringify(record),{onlyIf:{etagDoesNotMatch:'*'}});if(saved===null)record=await loadJSON(env,key)||record;}
   catch{return false;}
  }
  if(record.delivered){if(indexed)await clearEventOutbox(env,key);return true;}
  let journaled=false;
  for(let attempt=0;attempt<3&&!journaled;attempt++){try{await writeEvent(env,record.event);journaled=true;}catch{/* tried again, then probed below */}}
  if(!journaled&&created&&!indexed){
   let present=null;try{present=!!await env.BUCKET.head(removalEventKey(record.event));}catch{present=null;}
   if(present===false){try{await env.BUCKET.delete(key);}catch{/* an unindexed record that cannot be removed is replay-safe: it keeps its `at` */}}
   else if(present===true)journaled=true;
  }
  if(!journaled)return false;
  let marked=false;
  for(let attempt=0;attempt<3&&!marked;attempt++){try{record.delivered=true;await saveJSON(env,key,record);marked=true;}catch{/* the item exists; a sweep or a replay marks it */}}
  if(marked&&indexed)await clearEventOutbox(env,key);
  return true;
 }catch{return false;}
}
// The read side of the outbox: counts only, one small object, no write.
async function eventOutboxStatus(env){
 try{
  const aux=await auxAuthority(env);
  if(aux){const status=await PredictionAux.outboxStatus(auxDb(env));return {pending:status.states.pending||0,quarantined:status.states.quarantined||0,oldestSince:status.oldestPendingSince,maxAttempts:EVENT_OUTBOX_ATTEMPTS,skippedActivePending:status.skippedActivePending,skippedCap:status.skippedCap,capRefusals:status.capRefusals};}
 }catch{return {pending:null,quarantined:null,oldestSince:null,maxAttempts:EVENT_OUTBOX_ATTEMPTS};}
 try{
  const index=await loadJSON(env,EVENT_OUTBOX_KEY),entries=Object.entries(isObject(index?.pending)?index.pending:{}).filter(([key])=>eventOutboxKey(key));
  const since=entries.map(([,entry])=>entry?.since).filter(value=>typeof value==='string').sort()[0]||null;
  return {pending:entries.filter(([,entry])=>!entry?.quarantined).length,quarantined:entries.filter(([,entry])=>entry?.quarantined).length,oldestSince:since,maxAttempts:EVENT_OUTBOX_ATTEMPTS};
 }catch{return {pending:null,quarantined:null,oldestSince:null,maxAttempts:EVENT_OUTBOX_ATTEMPTS};}
}
const PREDICTION_STEP_NAMES=['start','next','submit','heartbeat','complete','validate','manifest','hold'];
const CALLER_FAULT_ORIGINS=['worker_http','transport','model_provider','orchestrator','unknown'];
const EXTERNAL_STOPS=['api_error','model_unavailable','model_error','external_termination','client_state_lost','manifest_unusable'];
const NORMAL_COMPLETE=['queue_empty','eligible_queue_empty','parse_error','retry_backoff','manifest_spent'];
const FAULT_REASONS=['quota','model_unavailable','api_error','storage_error','lease_lost','format_error_storm','profile_changed','lease_expired','external_termination','model_error','runner_aborted','time_budget','priority_changed','client_state_lost','manifest_unusable'];
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
// AIR-417. Where a failed prediction boundary failed: the stage, the sanitized error code and guard, one log line per failure. Never a
// message, a stack, a film id or a body. The 502 answer is unchanged. `stage` is set on the error by atStage at the first boundary it crosses.
const SAFE_LOG_TOKEN=/^[a-z0-9_]{1,60}$/,SAFE_LOG_ID=/^[A-Za-z0-9_-]{1,100}$/;
const safeLogToken=value=>typeof value==='string'&&SAFE_LOG_TOKEN.test(value)?value:null;
async function atStage(name,work){try{return await work();}catch(error){if(error&&typeof error==='object'&&!error.stage)error.stage=name;throw error;}}
function logPredictionFailure(boundary,error,requestId,runId){
 try{console.warn(JSON.stringify({event:'prediction_boundary_failed',boundary:safeLogToken(boundary),stage:safeLogToken(error?.stage)||'unknown',code:safeLogToken(error?.code)||'unknown',guard:safeLogToken(error?.guard),kind:safeLogToken(String(error?.name||'').toLowerCase()),requestId:typeof requestId==='string'&&SAFE_LOG_ID.test(requestId)?requestId:null,runId:typeof runId==='string'&&SAFE_LOG_ID.test(runId)?runId:null}));}catch{/* logging never changes the outcome */}
}
// AIR-438. Where the time of a `next` or `submit` goes: one sanitized log line `prediction_step_timing` per step. The Worker's environment is
// replaced, for the length of the step, by one whose R2 bucket and D1 database time every call they receive and then forward it unchanged: no
// call is added, reordered, retried or awaited differently, so the control flow, the CAS and lease protocols and the answer are the ones of before.
// A call is classed by what it touches (an R2 key shape or a D1 table name from a closed vocabulary), never by an id, and the line holds
// counts, sizes, milliseconds and a few whitelisted counters, never a film id, a key, a statement, a body or a model output. Calls that run in
// parallel are not summed as if sequential: `busyMs` is the union of their intervals, `overlapMs` what the sum exceeds it by, and
// `unattributedMs` the rest of the wall time (compute, scheduling, the awaits between calls). A failure of any of this is swallowed.
const STEP_TIMER=Symbol('predictionStepTimer');
const STEP_NOTES=['items','selected','pending','batchSize','bodyItems','predictionOnly','fingerprintAndPrediction','created','recalculated','alreadyCurrent','failures','manifestFilms','manifestBytes','deferredBudget','needsRegeneration','preflights','refreshRounds','scannedFilms','settledFilms','leaseRefused','leaseRefusedAtAcquire','liveLeaseAgeMs','drainedCommitted','drainedDropped','priorityLagAccepted','priorityRebased','keyed','joined','startPending','keyArgsMismatch','claimRenewals','claimLost','deferredAccepted','deferredReplay','deferredUnavailable','claimChecks','orderingDeferred','orderingDeferredWindow','answerBytes','envelopeAnswer'];
const STEP_STAGES=['preflight','turned_away','idle','settle_previous','catalog_gate','queue_refresh','preflight_refreshed','runner_lease','preflight_lease','persist','event_delivery','terminal_event','manifest_ready'],STEP_STAGE_CAP=16;
const STEP_OPS_CAP=4000,STEP_CLASS_CAP=40;
const STEP_TABLE=/\b(?:from|into|update|join)\s+["`]?([a-z_][a-z0-9_]{0,59})["`]?/i;
function stepKeyClass(key){
 const k=typeof key==='string'?key:'';
 if(k===profileKey)return 'profile';if(k===RUNNER_LEASE_KEY||k===PREDICTION_MUTATION_LEASE)return 'lease';
 if(k.startsWith(ENRICHMENT_KEY+'runs/'))return 'run';if(k===ENRICHMENT_KEY+'latest-run.json')return 'run_latest';
 if(k.startsWith(ENRICHMENT_KEY+'run-diagnostics'))return 'diagnostics';
 if(k==='epg/published-generation.json')return 'epg_generation';if(k==='sync.json')return 'sync';
 if(k.startsWith(ENRICHMENT_KEY+'profile/'))return 'profile_version';
 if(k==='epg/discovered-films.json')return 'catalog';
 if(k.startsWith('events/')||k.startsWith(ENRICHMENT_KEY+'start-events/')||k===ENRICHMENT_KEY+'event-outbox.json')return 'events';
 if(k.startsWith(ENRICHMENT_KEY+'sources/'))return 'source';if(k===ENRICHMENT_KEY+'view-index.json')return 'view_index';
 if(k===BATCH_STAGE_KEY||k.startsWith(ENRICHMENT_KEY+'batch-stage'))return 'batch_stage';
 if(k.startsWith(ENRICHMENT_KEY+'batch-manifest/'))return 'batch_manifest';
 if(k.startsWith(ENRICHMENT_KEY+'batch-hold/'))return 'batch_stage';
 if(k.startsWith(ENRICHMENT_KEY+'films/'))return /\/(?:fingerprint|predictions)\.json$/.test(k)?'film_state':'film_other';
 if(k===predictionQueueKey)return 'queue';if(k.startsWith(ENRICHMENT_KEY+'diagnostics/')||k.includes('/diagnostic'))return 'diagnostics';
 if(k==='programme.json'||k.endsWith('/programme.json'))return 'programme';
 return 'other';
}
function stepSqlClass(sql){const m=typeof sql==='string'?STEP_TABLE.exec(sql):null;return m?m[1].toLowerCase():'other';}
function createStepTimer(now=Date.now){
 const started=now(),ops=[],classes=new Map(),notes={},total={r2:{n:0,ms:0,bytesIn:0,bytesOut:0},d1:{n:0,ms:0,statements:0,batches:0,rowsRead:0,rowsWritten:0}};
 let truncated=false;const stages=[];
 const union=list=>{let sum=0,end=-Infinity;for(const [a,b] of list.slice().sort((x,y)=>x[0]-y[0])){if(b<=a)continue;if(a>end){sum+=b-a;end=b;}else if(b>end){sum+=b-end;end=b;}}return sum;};
 const record=(kind,cls,op,from,to,extra={})=>{try{
  const ms=Math.max(0,to-from),bucket=total[kind];bucket.n++;bucket.ms+=ms;
  if(kind==='r2'){bucket.bytesIn+=extra.bytesIn||0;bucket.bytesOut+=extra.bytesOut||0;}else{bucket.statements+=extra.statements||0;bucket.batches+=extra.batch?1:0;bucket.rowsRead+=extra.rowsRead||0;bucket.rowsWritten+=extra.rowsWritten||0;}
  const label=kind+':'+cls;let entry=classes.get(label);
  if(!entry){if(classes.size>=STEP_CLASS_CAP){truncated=true;return;}entry={n:0,ms:0,bytes:0,maxMs:0,ops:{}};classes.set(label,entry);}
  entry.n++;entry.ms+=ms;entry.maxMs=Math.max(entry.maxMs,ms);entry.bytes+=(extra.bytesIn||0)+(extra.bytesOut||0);entry.ops[op]=(entry.ops[op]||0)+1;
  if(ops.length<STEP_OPS_CAP)ops.push([from,to,kind]);else truncated=true;
 }catch{truncated=true;}};
 const note=fields=>{try{for(const name of STEP_NOTES){const value=fields?.[name];if(Number.isSafeInteger(value)&&value>=0)notes[name]=value;}}catch{/* a note never changes the step */}};
 // A stage is a named sequential section of one step: its wall time and how many R2 and D1 calls finished inside it. Names come from the closed STEP_STAGES list.
 // A stage that runs INSIDE another (AIR-553: `event_delivery` and `manifest_ready` inside `persist`) is subtracted from the outer one, so the sections stay exclusive and their sums never exceed the totals.
 const open=[];
 const stage=async(name,work)=>{
  const from=now(),r2=total.r2.n,d1=total.d1.n,frame={ms:0,r2:0,d1:0};open.push(frame);
  try{return await work();}
  finally{open.pop();try{
   const ms=Math.max(0,now()-from),r2n=total.r2.n-r2,d1n=total.d1.n-d1;
   if(open.length){const parent=open[open.length-1];parent.ms+=ms;parent.r2+=r2n;parent.d1+=d1n;}
   if(STEP_STAGES.includes(name)&&stages.length<STEP_STAGE_CAP)stages.push({stage:name,ms:Math.max(0,ms-frame.ms),r2:Math.max(0,r2n-frame.r2),d1:Math.max(0,d1n-frame.d1)});else truncated=true;
  }catch{truncated=true;}}
 };
 const summary=(step,fields)=>{
  const wallMs=Math.max(0,now()-started),busyMs=union(ops.map(([a,b])=>[a,b])),r2Busy=union(ops.filter(o=>o[2]==='r2').map(([a,b])=>[a,b])),d1Busy=union(ops.filter(o=>o[2]==='d1').map(([a,b])=>[a,b])),summed=total.r2.ms+total.d1.ms;
  const byClass={};for(const [label,entry] of classes)byClass[label]={n:entry.n,ms:entry.ms,maxMs:entry.maxMs,bytes:entry.bytes,ops:entry.ops};
  return {event:'prediction_step_timing',step,...fields,wallMs,busyMs,overlapMs:Math.max(0,summed-busyMs),unattributedMs:Math.max(0,wallMs-busyMs),r2:{...total.r2,busyMs:r2Busy},d1:{...total.d1,busyMs:d1Busy},classes:byClass,notes,...(stages.length?{stages}:{}),...(truncated?{truncated:true}:{})};
 };
 return {record,note,stage,summary,now};
}
// An R2 object whose body readers are timed (the body is read after `get` has answered, and that is I/O too). Everything else is the real object.
function timedR2Object(object,timer,cls){
 if(!object||typeof object!=='object')return object;
 return new Proxy(object,{get(target,prop){
  const value=Reflect.get(target,prop,target);
  if(typeof value!=='function')return value;
  if(prop==='json'||prop==='text'||prop==='arrayBuffer'||prop==='blob'||prop==='bytes')return async(...args)=>{const from=timer.now();try{return await value.apply(target,args);}finally{timer.record('r2',cls,'body',from,timer.now(),{bytesOut:target.size>=0?target.size:0});}};
  return value.bind(target);
 }});
}
function timedBucket(bucket,timer){
 const timedCall=(name,method,classOf,extraOf)=>async(...args)=>{
  const from=timer.now();let result;
  try{result=await method.apply(bucket,args);return name==='get'?timedR2Object(result,timer,classOf(args)):result;}
  finally{let extra={};try{extra=extraOf?extraOf(args,result):{};}catch{extra={};}timer.record('r2',classOf(args),name,from,timer.now(),extra);}
 };
 const keyOf=args=>stepKeyClass(args[0]);
 const sizeOf=value=>typeof value==='string'||(value&&typeof value.byteLength==='number')?(typeof value==='string'?value.length:value.byteLength):0;
 const wrapped={
  get:timedCall('get',bucket.get,keyOf),
  put:timedCall('put',bucket.put,keyOf,args=>({bytesIn:sizeOf(args[1])})),
  head:timedCall('head',bucket.head,keyOf),
  delete:timedCall('delete',bucket.delete,keyOf),
  list:timedCall('list',bucket.list,()=>'list')
 };
 return new Proxy(bucket,{get(target,prop){if(Object.hasOwn(wrapped,prop)&&typeof target[prop]==='function')return wrapped[prop];const value=Reflect.get(target,prop,target);return typeof value==='function'?value.bind(target):value;}});
}
function timedDatabase(db,timer){
 const real=new WeakMap();
 const unwrap=statement=>real.get(statement)||statement;
 const meta=result=>{const m=result&&result.meta;return {rowsRead:Number(m?.rows_read)||0,rowsWritten:Number(m?.rows_written)||0};};
 const statementOf=(statement,sql)=>{
  const proxy=new Proxy(statement,{get(target,prop){
   const value=Reflect.get(target,prop,target);
   if(typeof value!=='function')return value;
   if(prop==='bind')return(...args)=>statementOf(value.apply(target,args),sql);
   if(prop==='first'||prop==='all'||prop==='run'||prop==='raw')return async(...args)=>{const from=timer.now();let result;try{result=await value.apply(target,args);return result;}finally{let extra={};try{extra={statements:1,...meta(result)};}catch{extra={statements:1};}timer.record('d1',stepSqlClass(sql),prop,from,timer.now(),extra);}};
   return value.bind(target);
  }});
  real.set(proxy,statement);return proxy;
 };
 return new Proxy(db,{get(target,prop){
  const value=Reflect.get(target,prop,target);
  if(typeof value!=='function')return value;
  if(prop==='prepare')return sql=>statementOf(value.call(target,sql),sql);
  if(prop==='batch')return async(statements,...rest)=>{const from=timer.now();let results;const list=Array.isArray(statements)?statements.map(unwrap):statements;try{results=await value.call(target,list,...rest);return results;}finally{let extra={};try{extra={batch:true,statements:Array.isArray(list)?list.length:0};for(const item of Array.isArray(results)?results:[]){const m=meta(item);extra.rowsRead=(extra.rowsRead||0)+m.rowsRead;extra.rowsWritten=(extra.rowsWritten||0)+m.rowsWritten;}}catch{/* sizes are best effort */}timer.record('d1','batch','batch',from,timer.now(),extra);}};
  if(prop==='exec')return async(sql,...rest)=>{const from=timer.now();try{return await value.call(target,sql,...rest);}finally{timer.record('d1',stepSqlClass(sql),'exec',from,timer.now(),{statements:1});}};
  if(prop==='withSession')return(...args)=>timedDatabase(value.apply(target,args),timer);
  return value.bind(target);
 }});
}
function stepTimedEnv(env,timer){
 // An own copy, not a prototype link: callers spread the environment (`{...env,epgPin}`), and a spread must keep every binding and the timer.
 const timed={...env,[STEP_TIMER]:timer};
 if(env.BUCKET&&typeof env.BUCKET==='object')timed.BUCKET=timedBucket(env.BUCKET,timer);
 const database=typeof PredictionD1==='undefined'||typeof PredictionD1.timedBinding!=='function'?null:PredictionD1.timedBinding(env,binding=>timedDatabase(binding,timer));
 if(database)timed.DB=database;
 return timed;
}
const noteStep=(env,fields)=>{try{const timer=env?.[STEP_TIMER];if(timer)timer.note(fields());}catch{/* a note never changes the step */}};
const forgetAuthority=env=>{try{if(typeof PredictionD1!=='undefined'&&typeof PredictionD1.forgetRequestAuthority==='function')PredictionD1.forgetRequestAuthority(env);}catch{/* the next read is then merely shared */}};
const timedStage=(env,name,work)=>{const timer=env?.[STEP_TIMER];return timer&&typeof timer.stage==='function'?timer.stage(name,work):work();};
async function observedPrediction(env,body,work,stage,requestId,opts={}){
 const correlation=safeRequestId(requestId)||crypto.randomUUID();
 const started=Date.now(),attemptedAt=new Date(started).toISOString(),traceId=body?.diagnosticRunId||body?.runId||null;
 const stopId=()=>body?.runId||'blocked-'+(body?.trigger==='scheduled'?'scheduled':'manual')+'-'+Math.floor(Date.now()/3600000);
 const stopFallback=extra=>({start:stage==='start',trigger:body?.trigger,...(body?.protocol===BATCH_PROTOCOL?{protocol:BATCH_PROTOCOL}:{}),...extra});
 const entered=predictionStep({step:stage,requestId:correlation,attemptedAt,outcome:'entered'});
 // ADR 0188: a claimed start passes a fence; a handler that no longer holds its gate writes no step, no stop and no run (the answer below is `start_claim_lost`).
 // Ownership is read through the fence; a fence that itself throws is "unknown", which is treated as still ours for the release (the release is fenced by the run id, so it cannot touch another holder) and answered as a recoverable storage error.
 const fenceState=async()=>{try{return {mine:!!await opts.fence(),unknown:false};}catch{return {mine:false,unknown:true};}};
 const fencedAnswer=async(state)=>{
  // A fence that threw says nothing: read the lease itself. Another live holder means superseded (nothing is released); an unreadable or still-ours lease is treated as ours.
  if(state.unknown&&body?.runId){try{const current=await loadJSON(env,RUNNER_LEASE_KEY);if(current?.runId&&current.runId!==body.runId&&Number(current.expiresAt)>Date.now())state={mine:false,unknown:false};}catch{/* unreadable: still treated as ours */}}
  const ours=state.mine||state.unknown;
  if(ours&&body?.runId)await runnerLease(env,body.runId,'release',null,Number.isInteger(opts.epoch)?opts.epoch:null).catch(()=>null);
  return withPredictionCorrelation(json(ours?{status:'blocked',reason:'storage_error',error:'storage_error',code:'start_storage_error',runId:body?.runId||null,recoverable:true,...scheduledRunFields()}:{status:'blocked',reason:'start_claim_lost',code:'start_claim_lost',runId:body?.runId||null,...scheduledRunFields()},ours?502:409),correlation);
 };
 if(typeof opts.fence==='function'){const state=await fenceState();if(!state.mine)return fencedAnswer(state);}
 await safeAppendStep(env,traceId,entered);
 let response,data;try{response=await work();data=await response.clone().json();}catch(error){
  logPredictionFailure(stage,error,correlation,traceId);
  // ADR 0188: an exception in a claimed start never reaches the unfenced stop recorder. The fence says whether this handler still owns the run: if not, it answers `start_claim_lost`; if it does,
  // it releases its own (fenced) lease and answers a bounded recoverable `start_storage_error`. Neither writes a run, a stop Event, a step, a retry or `latest-run`.
  if(typeof opts.fence==='function')return fencedAnswer(await fenceState());
  const id=stopId();
  await safeAppendStep(env,traceId||id,predictionStep({step:stage,requestId:correlation,attemptedAt,outcome:'failed',httpStatus:502,elapsedMs:Date.now()-started,errorClass:'storage_error'}));
  const stop=await recordRunStop(env,id,'storage_error',stopFallback());
  return withPredictionCorrelation(json({...stop,error:'storage_error'},502),correlation);
 }
 // A superseded keyed start is not a stop of anything and records nothing.
 if(opts.fence&&(data.code==='start_claim_lost'||data.code==='start_storage_error'))return response;
 const normal=['queue_empty','eligible_queue_empty','retry_backoff'];
 // A start that cannot write the previous run's retries took no lease and created no run: it is not a stop of anything.
 // ADR 0195: a foreign Task's call (`wrong_owner`) is the caller's error, never a stop of the real owner's run.
 const stop=data.code==='prediction_retry_heal_pending'||data.code==='prediction_catalog_held'||data.code==='wrong_owner'||data.recoverable===true?null:data.status==='lease_lost'?'lease_lost':data.mustComplete&&!normal.includes(data.stopReason)?data.stopReason:data.status==='blocked'&&data.reason!=='retry_backoff'?data.reason:response.status>=500?'storage_error':response.status===409&&data.error?.includes('Profile changed')?'profile_changed':stage==='start'&&response.status===409&&data.error?'model_unavailable':null;
 const errorClass=stop==='lease_lost'||stop==='storage_error'||stop==='format_error_storm'?stop:null;
 const produced=predictionStep({step:stage,requestId:correlation,attemptedAt,completedAt:new Date().toISOString(),outcome:'produced',httpStatus:response.status,elapsedMs:Date.now()-started,errorClass});
 if(stop){const id=stopId();const final=await recordRunStop(env,id,stop,stopFallback(data));await safeAppendStep(env,traceId||id,produced);return withPredictionCorrelation(json({...data,...final,stage:stage==='start'?'blocked':final.stage,status:stage==='start'?'blocked':data.status||'partial'},response.status),correlation);}
 await safeAppendStep(env,traceId,produced);
 return withPredictionCorrelation(response,correlation);
}
async function predictionWriter(env,work){
 const head=typeof PredictionD1==='undefined'?null:await PredictionD1.openLease(env,PREDICTION_MUTATION_LEASE),object=head?head.object:await env.BUCKET.get(PREDICTION_MUTATION_LEASE),old=head?head.value:(object?await object.json():null);
 if(old?.expiresAt>Date.now())return json({status:'busy',reason:'prediction_writer_busy',...scheduledRunFields()},409);
 const lease={id:crypto.randomUUID(),expiresAt:Date.now()+90000},saved=head?await PredictionD1.writeLease(env,head,lease):await env.BUCKET.put(PREDICTION_MUTATION_LEASE,JSON.stringify(lease),{onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});
 if(saved===null)return json({status:'busy',reason:'prediction_writer_busy',...scheduledRunFields()},409);
 try{return await work({...env,[WRITER_OWNER]:lease.id});}finally{
  const releaseHead=typeof PredictionD1==='undefined'?null:await PredictionD1.openLease(env,PREDICTION_MUTATION_LEASE);
  if(releaseHead?.mode==='d1'){if(releaseHead.value?.id===lease.id)await PredictionD1.writeLease(env,releaseHead,{...lease,expiresAt:0});}
  else{const current=await env.BUCKET.get(PREDICTION_MUTATION_LEASE);if(current&&(await current.json()).id===lease.id)await env.BUCKET.put(PREDICTION_MUTATION_LEASE,JSON.stringify({...lease,expiresAt:0}),{onlyIf:{etagMatches:current.etag}});}
 }
}
// ADR 0064: every write of the prediction queue is conditional on the etag of the object it read. A conflict re-reads the
// queue and its inputs and rebuilds, a bounded number of times; exhaustion throws and writes nothing. A put that throws is
// an unknown outcome and is never repeated blindly.
const PREDICTION_QUEUE_ATTEMPTS=5;
class PredictionQueueConflictError extends Error{constructor(trigger){super('Prediction queue changed during write ('+trigger+')');this.name='PredictionQueueConflictError';this.code='prediction_queue_conflict';this.trigger=trigger;}}
const predictionQueuePause=attempt=>attempt?new Promise(resolve=>setTimeout(resolve,10*2**attempt+Math.floor(Math.random()*10))):null;
const putPredictionQueue=(env,object,queue)=>env.BUCKET.put(predictionQueueKey,JSON.stringify(queue),{httpMetadata:{contentType:'application/json'},onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});
// A change of the stored queue that is not a rebuild. `apply` gets a copy of the current queue and returns the next value,
// or null to leave it as it is; an absent queue is never created here.
// AIR-442. `readQueueHead` is the read a conditional write is based on (the D1 head, or the object and its etag). `currentPredictionQueue` registers the head it read for the queue
// it returns; a mutation of that very queue object (`seed`) starts from that head instead of reading the queue a second time within the request. The write is still conditional on
// that head, so a change by another writer in between is a conflict, and the retry reads afresh like any other.
const QUEUE_HEADS=new WeakMap();
async function readQueueHead(env){
 const head=typeof PredictionD1==='undefined'?null:await PredictionD1.openQueue(env),object=head?head.object:await env.BUCKET.get(predictionQueueKey),current=head?head.queue:(object?await object.json():null);
 return {head,object,current};
}
async function mutatePredictionQueue(env,apply,trigger,seed=null){
 for(let attempt=0;attempt<PREDICTION_QUEUE_ATTEMPTS;attempt++){
  await predictionQueuePause(attempt);
  const known=attempt===0&&seed?QUEUE_HEADS.get(seed):null,{head,object,current}=known||await readQueueHead(env);if(!current)return null;
  const next=apply(cloneJSON(current));if(next==null)return current;
  if((head?await PredictionD1.writeQueue(env,head,next):await putPredictionQueue(env,object,next))!==null)return next;
 }
 throw new PredictionQueueConflictError(trigger);
}
// Ten saved per-film retryable failures exhaust automatic selection. Eligibility is this counter, not a Film status.
const PREDICTION_RETRY_ATTEMPT_BUDGET=10;
const PREDICTION_RETRY_EXHAUSTED_KEEP=500;
function retryablePerFilmFailure(failure){
 if(!failure||typeof failure!=='object')return false;
 if(failure.scope==='run')return false;
 const kind=failure.kind;
 return kind==='parse_error'||kind==='validation_error'||kind==='validation_failure';
}
function retryBudgetExhausted(record){return Number.isInteger(record?.attempts)&&record.attempts>=PREDICTION_RETRY_ATTEMPT_BUDGET;}
function countsTowardFormatStorm(validation){
 if(validation?.stage==='caller_reported'&&validation.claimed?.reason)return false;
 return true;
}
function recountQueueLanes(queue){
 const pendingSet=new Set(queue.pending||[]);
 queue.priorityCount=queue.hotPending.length;queue.coldRemaining=queue.coldPending.length;queue.urgentCount=queue.hotPending.filter(id=>queue.priority[id]?.rank===0).length;queue.coldWithoutPrediction=queue.coldPending.filter(id=>!pendingSet.has(id)).length;
}
function holdRetryExhaustedFilm(queue,id){
 const gone=String(id);
 const inLane=queue.pending.includes(gone)||queue.hotPending.includes(gone)||queue.coldPending.includes(gone)||queue.priority[gone]||queue.work?.[gone];
 if(!inLane)return false;
 const keep=list=>list.filter(item=>item!==gone);
 queue.pending=keep(queue.pending);queue.hotPending=keep(queue.hotPending);queue.coldPending=keep(queue.coldPending);
 delete queue.priority[gone];if(queue.work)delete queue.work[gone];
 recountQueueLanes(queue);
 return true;
}
function boundRetryRecords(retries,currentIds){
 const held=[],historical=[];
 for(const [id,record] of Object.entries(retries||{})){
  if(retryBudgetExhausted(record)){
   if(currentIds.has(id))held.push([id,record]);
   else historical.push([id,record]);
  }else if(currentIds.has(id))held.push([id,record]);
 }
 historical.sort((a,b)=>Date.parse(b[1].failedAt||0)-Date.parse(a[1].failedAt||0));
 return Object.fromEntries([...held,...historical.slice(0,PREDICTION_RETRY_EXHAUSTED_KEEP)]);
}
// A retry record only grows while its film is outstanding: attempts and retryAt never go back, and the same run's record
// is written once. Systemic run failures do not increment the per-film budget.
function mergeRetryRecord(existing,failure,runId){
 if(existing?.lastRunId===runId)return existing;
 if(!retryablePerFilmFailure(failure))return existing||null;
 const attempts=Math.max(failure.attempts||0,(existing?.attempts||0)+1),failedMs=Date.parse(failure.failedAt)||Date.now();
 return {...failure,attempts,retryAt:Math.max(failure.retryAt||0,existing?.retryAt||0,failedMs+Math.min(6*3600000,3600000*2**(attempts-1))),lastRunId:runId};
}
// The run's failures not yet in the queue (a lost or failed submit write) are recorded; returns whether any was added.
function recordRunRetries(queue,run){
 queue.retries||={};let added=false;
 for(const [id,failure] of Object.entries(run.failures||{})){
  const record=failure&&typeof failure==='object'?failure:{kind:failure};
  const merged=mergeRetryRecord(queue.retries[id],{kind:record.kind||'storage_error',scope:record.scope||'run',retryable:true,failedAt:record.failedAt||run.completedAt||new Date().toISOString(),retryAt:record.retryAt||0,attempts:record.attempts||0,...(record.validation?{validation:record.validation}:{})},run.runId);
  if(!merged||merged===queue.retries[id])continue;
  queue.retries[id]=merged;added=true;
  if(retryBudgetExhausted(merged))holdRetryExhaustedFilm(queue,id);
 }
 return added;
}
// A queued run's failure reaches the run record before the queue, marked `retryHeal: 'pending'` until a queue write confirms
// the run's retries. A failed confirmation (conflict exhaustion, a put that throws, no queue) keeps the mark: the runner
// lease keeps naming the run after release, so the next start confirms them before it selects anything, or starts nothing.
async function settleRunRetries(env,run,trigger){
 if(run?.retryHeal!=='pending')return true;
 try{if(run.mode==='queued'&&!await mutatePredictionQueue(env,queue=>recordRunRetries(queue,run)?queue:null,trigger))return false;}catch{return false;}
 delete run.retryHeal;return true;
}
async function settlePreviousRun(env,heldRunId=null){
 // A keyed start already holds the lease as a claim, so the previous holder is the one its acquire recovered (ADR 0188), not the lease record.
 let previousId=heldRunId;
 if(!previousId){const lease=await loadJSON(env,RUNNER_LEASE_KEY);if(!lease?.runId||lease.expiresAt>Date.now())return null;previousId=lease.runId;}
 const run=await checkedRun(env,previousId);if(run?.retryHeal!=='pending')return null;
 if(await settleRunRetries(env,run,'start_retries')){await saveJSON(env,runKey(run.runId),run);return null;}
 return json({status:'blocked',reason:'retry_heal_pending',code:'prediction_retry_heal_pending',pendingRunId:run.runId,...scheduledRunFields()},503);
}
// `beforeWrite` lets a lease-holding caller renew its lease immediately before each queue write; `amend` changes the rebuilt
// queue inside the same conditional write (run bookkeeping), so a conflict re-applies it to the fresh rebuild.
// `capture` (an object) receives the inputs of the rebuild that was written (report, profile, index, catalog), so a caller that needs them
// next does not read the same large objects again in the same request.
async function refreshPredictionQueue(env,report,trigger='reconcile',{beforeWrite=null,amend=null,capture=null}={}){
 for(let attempt=0;attempt<PREDICTION_QUEUE_ATTEMPTS;attempt++){
  await predictionQueuePause(attempt);
  // The queue is read before its inputs, so a rebuild never rests on a profile, index or programme older than the queue it
  // replaces. A caller's programme of another generation than the stored queue is replaced by the published one.
  const head=typeof PredictionD1==='undefined'?null:await PredictionD1.openQueue(env),object=head?head.object:await env.BUCKET.get(predictionQueueKey),previous=head?head.queue:(object?await object.json():null);
  const source=previous?.programmeRunId&&previous.programmeRunId!==report?.runId?await loadJSON(env,'programme.json')||report:report;
  if(!source?.runId&&!(Array.isArray(source?.films)&&source.films.length))return previous;
  const queue=await buildPredictionQueue(env,source,trigger,previous,capture);if(!queue)return null;
  const next=amend?amend(queue)||queue:queue;
  if(beforeWrite)await beforeWrite();
  if((head?await PredictionD1.writeQueue(env,head,next):await putPredictionQueue(env,object,next))!==null)return next;
 }
 throw new PredictionQueueConflictError(trigger);
}
// A rebuild reads the whole catalog as one admission snapshot (ADR 0147). A continuation or status write that only
// bumps the Discovery generation does not fence it. A held cutover, a non-seal load, or an EPG pin change still
// throws `discovery_fence` / `discovery_incomplete`; those are retried a few times, then raised.
async function loadCatalogForQueue(pinned){
 for(let attempt=1;;attempt++){
  try{return await loadJSON(pinned,'epg/discovered-films.json');}
  catch(error){if(error?.code!=='discovery_fence'||attempt>=CATALOG_FENCE_ATTEMPTS)throw error;}
 }
}
async function queuePin(env,report){
 if(env?.epgPin?.authority==='d1'&&env.epgPin.programmeRunId)return env;
 if(typeof PublishedEpg!=='undefined'){
  const live=await PublishedEpg.currentGeneration(env);
  if(live)return {...env,epgPin:{authority:'d1',programmeRunId:live.programmeRunId,phase:live.phase,fence:live.fence,generation:live.generation}};
 }
 if(report?.runId)return {...env,epgPin:{...(env.epgPin||{}),programmeRunId:report.runId}};
 return pinEpg(env);
}
function publishedEpgUnavailable(){
 const error=new Error('published_epg_unavailable');
 error.code='published_epg_unavailable';
 throw error;
}
// A D1 pin whose run is not the caller's completed programme is not R2: reload the pinned generation, or fail closed.
async function consistentQueueReport(pinned,report){
 if(pinned?.epgPin?.authority!=='d1'||!pinned.epgPin.programmeRunId)return report;
 if(report?.runId===pinned.epgPin.programmeRunId)return report;
 const reloaded=await loadJSON(pinned,'programme.json');
 if(!reloaded||reloaded.runId!==pinned.epgPin.programmeRunId)publishedEpgUnavailable();
 return reloaded;
}
// AIR-536: `options.now` pins the evaluation instant (the parity read evaluates at its own cutoff); every caller that omits it keeps the wall clock.
async function buildPredictionQueue(env,report,trigger,previous,capture=null,options={}){
 const pinned=await queuePin(env,report);
 // AIR-529: read BEFORE the programme and catalog are used, so an assignment landing during the rebuild leaves the stored signature older than the data and costs one more refresh, never a missed one.
 const showsSignature=await currentShowsSignature(pinned,report);
 const source=await consistentQueueReport(pinned,report);
 const [profile,storedIndex,catalog,sync]=await Promise.all([loadJSON(env,profileKey),loadJSON(env,ENRICHMENT_KEY+'view-index.json'),loadCatalogForQueue(pinned),loadJSON(env,'sync.json')]);
 const index=storedIndex;
 if(!profile)return null;
 const recovery=await predictionRecoveryOverlay(env);let recoveryDenied=0;
 const safeSource=source&&Array.isArray(source.films)?source:{runId:source?.runId||null,films:[]};
 if(capture)Object.assign(capture,{report:safeSource,profile,index,catalog});
 const now=Number.isFinite(options?.now)?options.now:Date.now();
 const authoritative=showsAuthoritative(sync,safeSource);
 const watchlistDoc=authoritative?null:await loadJSON(env,'watchlist.json');
 // ADR 0142: completed-only ranking is a live D1 published pin whose run matches the completed programme, not the mere presence of the PublishedEpg module (the Worker always bundles it; currentGeneration null is the R2 path).
 const completedOnly=authoritative&&pinned?.epgPin?.authority==='d1'&&!!pinned.epgPin.programmeRunId&&safeSource.runId===pinned.epgPin.programmeRunId;
 const completed=completedOnly?completedShowsByTmdb(safeSource):new Map();
 // ADR 0186 (AIR-569): with the Watchlist marker `d1` the queue's membership is the current snapshot, not the membership of the completed EPG generation (the undefined function is the legacy path).
 const currentMembership=authoritative&&typeof watchlistQueueMembership==='function'?await watchlistQueueMembership(env,safeSource):null;
 const membership=authoritative?(currentMembership||safeSource):Array.isArray(watchlistDoc?.films)?{films:watchlistDoc.films}:{films:safeSource.films};
 const catalogFilms=allEnrichmentFilms(membership,catalog),queueIds=new Set(catalogFilms.map(f=>String(f.id)));
 // ADR 0201: an active recovery intent names a stored id; its catalog film carries it, so the index, the intent and the manifest agree on one key.
 const recovered=recovery.ready&&typeof PredictionRecoveryIntent!=='undefined'&&typeof PredictionRecoveryIntent.readRecoveredIds==='function'?await PredictionRecoveryIntent.readRecoveredIds(env):[],storedAliases=await storedIdCatalogAliases(env,recovered.filter(id=>!queueIds.has(id))),aliasOf=new Map([...storedAliases].map(([id,key])=>[key,id]));
 const films=catalogFilms.map(film=>aliasOf.has(String(film.id))?{...film,id:aliasOf.get(String(film.id))}:film).map(film=>authoritative?withCompletedShows(film,completed,safeSource.runId,completedOnly):{...film,shows:[],epgLastAiring:null});
 const watchlistIds=new Set(eligibleEnrichmentFilms(membership).map(f=>String(f.id)));
 if(capture)capture.films=films;
 let priorityBasis='completed',priorityProgrammeRunId=safeSource.runId;
 const priority=Object.fromEntries(films.map(f=>{
  const id=String(f.id);
  if(authoritative)return [id,{...predictionPriority(f,now),basis:'completed'}];
  const carried=carriedPredictionPriority(previous,id,now);
  if(carried){priorityBasis='carried';priorityProgrammeRunId=previous.programmeRunId||priorityProgrammeRunId;return [id,carried];}
  return [id,neutralPredictionPriority()];
 }));
 if(!authoritative&&priorityBasis!=='carried'){priorityBasis='neutral';priorityProgrammeRunId=previous?.programmeRunId||'priority-neutral';}
 const sameCompleted=authoritative&&previous?.priorityBasis==='completed'&&previous.programmeRunId===priorityProgrammeRunId&&previous.priorityAsOf;
 const priorityAsOf=authoritative?(sameCompleted?previous.priorityAsOf:new Date(now).toISOString()):priorityBasis==='carried'?(previous?.priorityAsOf||previous?.refreshedAt||null):null;
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
  const chosen=verdicts.selective,ordinary=predictionCompatibilityFresh(chosen);
  if(chosen&&predictionCompatibilityFresh(chosen)!==ordinary)fingerprintCompatibilityBlock.strictDisagreements++;
  // AIR-477: an owner-confirmed intent denies exactly this film's stored version; the film is then outstanding like any stale one.
  if(ordinary&&recovery.deniesPrediction(id,item.prediction)){
   recoveryDenied++;fresh.set(id,false);
   const requiredWork=recovery.modeOf?.(id)==='fingerprint_and_prediction'?'fingerprint_and_prediction':'prediction_only';
   fingerprintCompatibilityBlock.classes[requiredWork]++;work[id]={class:requiredWork,requiredWork,migration:null,reason:'recovery_intent'};continue;
  }
  const decided=ordinary;
  fresh.set(id,decided);
  if(decided){fingerprintCompatibilityBlock.classes.unchanged++;continue;}
  const fv=chosen.fingerprint,migration=!predictionCompatibilityFresh(fv)||chosen.reason?.startsWith('prompt_')?fv.migration==='none'?'prediction':fv.migration:null,unknown=['transition_unknown','transition_impact_unknown','film_features_unknown','prompt_transition_unknown','prompt_features_unknown'].includes(chosen.reason);
  fingerprintCompatibilityBlock.classes[chosen.requiredWork]++;if(migration)fingerprintCompatibilityBlock.classes.migration++;if(unknown)fingerprintCompatibilityBlock.classes.unknown++;
  work[id]={class:chosen.requiredWork,requiredWork:chosen.requiredWork,migration,reason:chosen.reason,...(fv.fields?{fields:fv.fields}:{})};
 }
 const missing=films.filter(f=>!fresh.get(String(f.id)));
 // ADR 0142 decision 13: the late tie-break uses the earliest start of the Film's completed (or, outside D1, record) showings, then discoveredAt, then the id. hotEnteredAt is not read.
 const earliestStart=film=>{const starts=(film.shows||[]).map(show=>Number(show.start)).filter(Number.isFinite);return starts.length?Math.min(...starts):0;};
 missing.sort((a,b)=>{const x=priority[a.id],y=priority[b.id];return x.rank-y.rank||(x.rank===0?x.expiresInMs-y.expiresInMs:0)||Number(y.availableNow||y.availableToday)-Number(x.availableNow||x.availableToday)||Number(!!index?.[a.id]?.prediction)-Number(!!index?.[b.id]?.prediction)||Number(!!work[a.id]?.migration)-Number(!!work[b.id]?.migration)||earliestStart(a)-earliestStart(b)||(Date.parse(b.discoveredAt)||0)-(Date.parse(a.discoveredAt)||0)||String(a.id).localeCompare(String(b.id),'en');});
 const currentIds=new Set(missing.map(f=>String(f.id))),retries=boundRetryRecords(previous?.retries||{},currentIds),exhausted=id=>retryBudgetExhausted(retries[id]);
 const hotPending=missing.filter(f=>priority[f.id].hot&&!exhausted(String(f.id))).map(f=>String(f.id)),coldPending=missing.filter(f=>!priority[f.id].hot&&!exhausted(String(f.id))).map(f=>String(f.id)),pending=[...hotPending,...coldPending.filter(id=>watchlistIds.has(id))];
 // AIR-529: the first instant an OUTSTANDING Film of this queue (not retry-exhausted; a Film with a current prediction cannot change what a start selects) changes hot/cold with the clock alone. The predicate is
 // `start >= now-72h && start < now+24h` (lower bound inclusive, upper exclusive), so a show is still cold AT start-24h and hot from start-24h+1 ms, and still hot AT start+72h and cold from start+72h+1 ms: the edges
 // below are those first instants. The batch preflight compares the earliest with the clock, so a rolling-window transition on an unchanged generation is re-evaluated at a natural start (never per submit or complete).
 let nextWindowChange=Infinity;
 if(authoritative)for(const film of missing){if(exhausted(String(film.id)))continue;for(const show of film.shows||[]){const at=Number(show?.start);if(!Number.isFinite(at))continue;for(const edge of [at-PRIORITY_HOT_FUTURE_MS+1,at+PRIORITY_HOT_PAST_MS+1])if(edge>now&&edge<nextWindowChange)nextWindowChange=edge;}}
 const hotCount=films.filter(f=>priority[f.id].hot).length,missingHot=missing.filter(f=>priority[f.id].hot).length,hotPredicted=hotCount-missingHot,hotCatalogPredicted=films.filter(f=>priority[f.id].hot&&!watchlistIds.has(String(f.id))&&fresh.get(String(f.id))).length,addedHot=previous?.hotPending?hotPending.filter(id=>!previous.hotPending.includes(id)).length:0;
 const queue={schemaVersion:3,hotCount,coldCount:films.length-hotCount,coldWithoutPrediction:coldPending.filter(id=>!watchlistIds.has(id)).length,hotPredicted,profileVersion:profile.version,profileHash:profile.profileHash,programmeRunId:priorityProgrammeRunId,priorityBasis,priorityAsOf,showsSignature:authoritative?(showsSignature.signature??null):null,priorityNextChangeAt:authoritative&&Number.isFinite(nextWindowChange)?new Date(nextWindowChange).toISOString():null,refreshedAt:new Date().toISOString(),trigger,pending,hotPending,coldPending,priorityCount:hotPending.length,coldRemaining:coldPending.length,urgentCount:hotPending.filter(id=>priority[id].rank===0).length,priority:Object.fromEntries(missing.map(f=>[String(f.id),priority[f.id]])),retries,lastBatch:previous?.lastBatch||null,lastCheckAt:previous?.lastCheckAt||null,metrics:{hotAddedTotal:(previous?.metrics?.hotAddedTotal||0)+addedHot,hotProcessedTotal:previous?.metrics?.hotProcessedTotal||0},compatibility,fingerprintCompatibility:fingerprintCompatibilityBlock,fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,fingerprintPromptVersion:FINGERPRINT_PROMPT_VERSION,predictionPromptVersion:PREDICTION_PROMPT_VERSION,work:Object.fromEntries(pending.map(id=>[id,work[id]]).filter(([,w])=>w)),discovery:{ready:hotCatalogPredicted>=100,minimum:100,target:200,hotPredicted:hotCatalogPredicted,reason:hotCatalogPredicted>=100?'usable_hot_sample':'warming_hot_sample'}};
 if(recovery.ready){queue.recoveryRevision=recovery.revision;queue.recovery={revision:recovery.revision,activeIntents:recovery.size,denied:recoveryDenied};}
 return queue;
}
// AIR-431. The Prediction queue advances on its own state. A runner step (next, submit, complete) no longer rebuilds the queue from the
// whole Discovery catalog: the persisted queue is the work list, a film that was predicted is settled out of it, and only the films a step
// actually needs (the metadata of the next batch) are read, by id. A full rebuild remains for start, a changed programme, profile or
// contract, and the named refresh callers; Discovery chunk traffic moves the Discovery generation, which no longer reaches the runner.
const QUEUE_STALE_LIMIT_MS=12*3600000;
const CATALOG_FENCE_ATTEMPTS=3;
const SETTLED_STATUSES=['created','recalculated','already_current'];
// A selected manifest film is spent when submit settled it (created/recalculated/already_current) or recorded a per-film retry failure. deferred_budget, needs_regeneration and unsubmitted slots are not spent (ADR 0136).
const manifestFilmSpent=(run,id)=>SETTLED_STATUSES.includes(run.results?.[id])||!!run.failures?.[id];
const manifestFullySpent=run=>Array.isArray(run?.selectedIds)&&run.selectedIds.length>0&&run.selectedIds.every(id=>manifestFilmSpent(run,id));
const queueShapeValid=queue=>!!queue&&typeof queue==='object'&&Array.isArray(queue.pending)&&Array.isArray(queue.hotPending)&&Array.isArray(queue.coldPending)&&!!queue.priority&&typeof queue.priority==='object'&&Number.isInteger(queue.priorityCount);
// Why a persisted queue cannot be advanced as it is (null: it can). The same inputs a rebuild stamps into the queue.
// ADR 0154. A completed programme authorizes hot/cold order only. An unfinished seal, a new programmeRunId or missing shows never block scoring.
const PRIORITY_CARRY_MS=36*3600000;
// The hot window of `predictionPriority`: a show start in [now - 72 h, now + 24 h).
const PRIORITY_HOT_PAST_MS=72*3600000,PRIORITY_HOT_FUTURE_MS=24*3600000;
// AIR-529, owner decision of 18 November 2026: the clock-only re-evaluation is a RATE CAP, not a freshness guarantee. A queue ranked on a completed programme is rebuilt for a hot/cold edge (`priorityNextChangeAt`, the first instant the
// predicate changes) at most once per interval, so a start does not pay a full rebuild every time an edge of thousands of outstanding Films passes. Within the interval after a rebuild, a Film that became hot may sit behind cold picks;
// that bound is the accepted relaxation of "hot before the next cold selection" for clock-only changes. It never applies to a changed shows signature or an unreadable one, which stay immediate. A queue without the field is not judged here.
const PRIORITY_WINDOW_REEVAL_MS=15*60000;
function windowEdgeReached(queue,report,now=Date.now()){
 if(!queue||queue.priorityBasis!=='completed'||queue.programmeRunId!==report?.runId||!queue.priorityNextChangeAt)return false;
 const next=Date.parse(queue.priorityNextChangeAt);
 return Number.isFinite(next)&&next<=now;
}
// 'window_transition' when an edge was reached and the interval since the last rebuild has passed; `deferred` when it was reached but the rate cap holds it back (reported, never a verified count).
function windowTransitionState(queue,report,now=Date.now()){
 if(!windowEdgeReached(queue,report,now))return {cause:null,deferred:false};
 const built=Date.parse(queue.refreshedAt||'');
 return Number.isFinite(built)&&now-built<PRIORITY_WINDOW_REEVAL_MS?{cause:null,deferred:true}:{cause:'window_transition',deferred:false};
}
function showsAuthoritative(sync,report){
 if(!report?.runId||!Array.isArray(report.films))return false;
 // No sync document: the programme object is the snapshot (R2-only and offline worlds).
 if(!sync)return true;
 // A completed sync confirms showtimes. A newer published programme may already have moved ahead of that row.
 if(sync.stage==='complete')return true;
 // An unsealed run that has not replaced the published programme leaves the previous snapshot in force.
 if(sync.runId&&sync.runId!==report.runId)return true;
 return false;
}
// AIR-529. The Discovery-assigned shows of the pinned D1 generation, as one signature. {applicable:false}: not a D1 pin of this programme (nothing to compare). {unreadable:true}: the read failed,
// which is unknown, never a match. {signature}: the value.
async function currentShowsSignature(pinned,report){
 if(typeof PublishedEpg==='undefined'||typeof PublishedEpg.assignedShowsSignature!=='function')return {applicable:false};
 const runId=pinned?.epgPin?.authority==='d1'?pinned.epgPin.programmeRunId:null;
 if(!runId||runId!==report?.runId)return {applicable:false};
 try{const signature=await PublishedEpg.assignedShowsSignature(pinned,runId);return signature?{signature}:{unreadable:true};}catch{return {unreadable:true};}
}
// Same generation, new Discovery assignments (AIR-529): the cause the queue is due, or null. A queue without a stored signature (built before this field, or while it was unreadable) is due. An UNREADABLE
// current signature is due too ('shows_signature_unreadable'): the hot/cold basis cannot be verified, so a start does not select cold on it silently; it tries the rebuild, and a rebuild that cannot read
// is the existing fail-closed or `queueStale` outcome, never a quiet cold pick.
function showsSignatureCause(queue,report,current){
 if(!current||current.applicable===false||!queue||queue.priorityBasis!=='completed'||queue.programmeRunId!==report?.runId)return null;
 if(current.unreadable)return 'shows_signature_unreadable';
 return queue.showsSignature===current.signature?null:'shows_signature_changed';
}
function priorityRefreshDue(queue,report,sync){
 if(!queueShapeValid(queue)||!showsAuthoritative(sync,report))return false;
 if(queue.priorityBasis==='carried'||queue.priorityBasis==='neutral')return true;
 return queue.programmeRunId!==report.runId;
}
function neutralPredictionPriority(){return {hot:false,availableNow:false,availableToday:false,availableUntil:null,rank:2,expiresInMs:Infinity,basis:'neutral'};}
// The 36h bound is the completed snapshot's own time, not the last rebuild. A carried queue keeps that instant in priorityAsOf.
function priorityOriginMs(previous){
 if(previous?.priorityAsOf)return Date.parse(previous.priorityAsOf);
 if(previous?.priorityBasis==='carried')return NaN;
 return Date.parse(previous?.refreshedAt||'');
}
function carriedPredictionPriority(previous,id,now){
 const origin=priorityOriginMs(previous),age=Number.isFinite(origin)?now-origin:Infinity;
 const basis=previous?.priorityBasis,fromCompleted=basis==='completed'||basis===undefined||basis==='carried';
 const stored=previous?.priority?.[id];
 if(fromCompleted&&age<=PRIORITY_CARRY_MS&&stored&&typeof stored==='object')return {...stored,basis:'carried'};
 return null;
}
// `recoveryRevision` (optional): the recovery intent revision read now. A queue built under another revision is rebuilt, so a confirmed
// or cancelled intent reaches the queue through the ordinary rebuild, never through a per-film queue write (ADR 0165).
function queueAdvanceGate(queue,report,profile,registry,recoveryRevision=null){
 if(!queueShapeValid(queue))return 'queue_shape';
 if(!profile||queue.profileHash!==profile.profileHash||queue.profileVersion!==profile.version)return 'profile_changed';
 if(queue.fingerprintSchemaVersion!==FINGERPRINT_SCHEMA_VERSION||(queue.fingerprintPromptVersion??1)!==FINGERPRINT_PROMPT_VERSION||queue.predictionPromptVersion!==PREDICTION_PROMPT_VERSION)return 'contract_changed';
 if(queue.fingerprintCompatibility?.registryDigest!==registry)return 'registry_changed';
 if(Number.isInteger(recoveryRevision)&&(queue.recoveryRevision??0)!==recoveryRevision)return 'recovery_changed';
 return null;
}
// Pure. The films leave every list, map and counter of the queue; null when none was in it (nothing to write). `compatibility`,
// `fingerprintCompatibility` and `discovery` are statistics of the last rebuild and stay as they were until the next one.
function settleQueueFilms(queue,ids){
 const gone=new Set((ids||[]).map(String)),inQueue=[...gone].filter(id=>queue.pending.includes(id)||queue.hotPending.includes(id)||queue.coldPending.includes(id)||queue.priority[id]||queue.work?.[id]||queue.retries?.[id]);
 if(!inQueue.length)return null;
 const hotGone=queue.hotPending.filter(id=>gone.has(id)).length,keep=list=>list.filter(id=>!gone.has(id));
 queue.pending=keep(queue.pending);queue.hotPending=keep(queue.hotPending);queue.coldPending=keep(queue.coldPending);
 for(const id of gone){delete queue.priority[id];if(queue.work)delete queue.work[id];if(queue.retries)delete queue.retries[id];}
 recountQueueLanes(queue);
 queue.hotPredicted=(queue.hotPredicted||0)+hotGone;queue.advancedAt=new Date().toISOString();
 return queue;
}
// The gate repeated on the queue a conditional write actually mutates. `currentPredictionQueue` validated a snapshot; a retry of the write after a
// conflict loads whatever is stored then (a reconcile, an EPG commit or a profile publication may have rebuilt it for another generation), so a
// settlement never touches a queue the gate would refuse: it returns null and the queue stays as its own generation wrote it.
async function advanceContext(env,report,profile,queue=null){
 const mismatch=!!queue?.programmeRunId&&!!report?.runId&&queue.programmeRunId!==report.runId;
 return {report,profile,sync:mismatch?await loadJSON(env,'sync.json'):null,registry:(await fingerprintRegistryDigests()).registry};
}
// A settlement must not land on a queue a later completed publication already rebuilt. An unsealed live programme is not that publication: the stored completed queue stays the work list (ADR 0154). A carried or neutral queue keeps the previous programme id on purpose.
function settlementGenerationRefused(queue,context){
 if(!queue?.programmeRunId||!context.report?.runId||queue.programmeRunId===context.report.runId)return false;
 if(queue.priorityBasis==='carried'||queue.priorityBasis==='neutral')return false;
 const sync=context.sync;
 if(sync&&sync.stage!=='complete'&&sync.runId===context.report.runId)return false;
 return true;
}
function guardedSettle(context,ids,trigger){
 return current=>{
  if(queueAdvanceGate(current,context.report,context.profile,context.registry))return null;
  if(settlementGenerationRefused(current,context))return null;
  const next=settleQueueFilms(current,ids);if(next&&trigger)next.trigger=trigger;return next;
 };
}
// The persisted queue when it can be advanced, otherwise a full rebuild. `force` rebuilds anyway (start). `fallback` lets a start that
// finds the catalog held keep working on a persisted queue that is still valid and not older than QUEUE_STALE_LIMIT_MS; the answer then
// carries `queueStale` (never silent). Any other failure, and a stale or invalid queue, is thrown as before.
async function currentPredictionQueue(env,report,profile,trigger,{force=false,fallback=false,capture=null}={}){
 const read=await readQueueHead(env),stored=read.current,why=queueAdvanceGate(stored,report,profile,(await fingerprintRegistryDigests()).registry,(await predictionRecoveryOverlay(env)).revision);
 if(stored&&!why)QUEUE_HEADS.set(stored,read);
 if(!force&&!why)return stored;
 try{return await refreshPredictionQueue(env,report,trigger,{capture});}
 catch(error){
  const age=stored?.refreshedAt?Date.now()-Date.parse(stored.refreshedAt):Infinity;
  if(fallback&&!why&&CATALOG_HELD_CODES.includes(error?.code)&&age<=QUEUE_STALE_LIMIT_MS){return Object.assign(stored,{queueStale:{reason:error.code,ageMs:age}});}
  throw error;
 }
}
// ADR 0201 (AIR-478). A film the owner watched leaves the watchlist, so the admitted catalog holds it under `tmdb_<n>` while its prediction state
// stays under the stored Letterboxd id. For the stored ids the caller names (never a scan), the trusted canonical Film bridge (no title or year
// matching) gives the catalog id of the same Film. A verified negative (absent, retired, conflicting identity; a Film/Person store that is not
// authoritative) yields no alias: the film stays unadmitted. Any other failure (an unavailable read, a moved generation) is thrown, never turned into absence.
const STORED_ALIAS_ID=/^[A-Za-z0-9_-]{1,80}$/,STORED_ALIAS_CONCURRENCY=8;
async function storedIdCatalogAliases(env,ids){
 const aliases=new Map();
 if(typeof CanonicalCatalogReader==='undefined'||typeof CanonicalCatalogReader.catalogFilmIdentityBridge!=='function')return aliases;
 const wanted=[...new Set((ids||[]).map(String))].filter(id=>STORED_ALIAS_ID.test(id)&&!id.startsWith('tmdb_'));
 for(let at=0;at<wanted.length;at+=STORED_ALIAS_CONCURRENCY){
  await Promise.all(wanted.slice(at,at+STORED_ALIAS_CONCURRENCY).map(async id=>{
   let identity;
   try{identity=await CanonicalCatalogReader.catalogFilmIdentityBridge(env,id);}
   catch(error){if(error?.code==='canonical_read_not_authoritative'||error?.code==='canonical_read_invalid')return;throw error;}
   if(identity?.state==='ok'&&identity.lid===id&&/^[1-9]\d{0,11}$/.test(String(identity.tmdb??'')))aliases.set(id,'tmdb_'+identity.tmdb);
  }));
 }
 return aliases;
}
// Films by id, for the metadata of a batch: the watchlist first, then the admitted catalog films by indexed id lookup (never the whole
// catalog). Outside D1 authority the R2 catalog serves them.
async function readFilmsById(env,report,ids,known=undefined){
 const wanted=[...new Set((ids||[]).map(String))],found=new Map(),watchlist=new Map(eligibleEnrichmentFilms(report).map(f=>[String(f.id),f]));let rest=[];
 for(const id of wanted){const film=watchlist.get(id);if(film)found.set(id,film);else rest.push(id);}
 if(!rest.length)return found;
 if(known){for(const id of rest){const film=known[id]||Object.values(known).find(f=>String(f?.id)===id);if(film)found.set(id,film);}return found;}
 const authority=typeof DiscoveryAuthority==='undefined'?null:await DiscoveryAuthority.readAdmissionsById(env,rest);
 if(authority?.handled){for(const [id,film] of authority.films)found.set(id,film);}
 else{const catalog=await loadJSON(env,'epg/discovered-films.json')||{};for(const id of rest){const film=catalog[id]||Object.values(catalog).find(f=>String(f?.id)===id);if(film)found.set(id,film);}}
 let still=rest.filter(id=>!found.has(id));
 if(still.length){
  const aliases=await storedIdCatalogAliases(env,still);
  if(aliases.size){
   const keys=[...new Set(aliases.values())],viaCatalog=new Map();
   const authority=typeof DiscoveryAuthority==='undefined'?null:await DiscoveryAuthority.readAdmissionsById(env,keys);
   if(authority?.handled){for(const [key,film] of authority.films)viaCatalog.set(key,film);}
   else{const catalog=await loadJSON(env,'epg/discovered-films.json')||{};for(const key of keys){const film=catalog[key]||Object.values(catalog).find(f=>String(f?.id)===key);if(film)viaCatalog.set(key,film);}}
   for(const [id,key] of aliases){const film=viaCatalog.get(key);if(film)found.set(id,{...film,id});}
   still=still.filter(id=>!found.has(id));
  }
 }
 if(still.length&&!showsAuthoritative(await loadJSON(env,'sync.json'),report&&Array.isArray(report.films)?report:{runId:report?.runId||null,films:[]})){
  const list=await loadJSON(env,'watchlist.json');
  if(Array.isArray(list?.films)){const extra=new Map(eligibleEnrichmentFilms({films:list.films}).map(f=>[String(f.id),f]));for(const id of still){const film=extra.get(id);if(film)found.set(id,film);}}
 }
 return found;
}
async function queueStatus(env){return queueStatusView(await loadJSON(env,predictionQueueKey));}
function queueStatusView(q){return q?{schemaVersion:q.schemaVersion,hotCount:q.hotCount,coldCount:q.coldCount,coldWithoutPrediction:q.coldWithoutPrediction,hotPredicted:q.hotPredicted,profileVersion:q.profileVersion,programmeRunId:q.programmeRunId,refreshedAt:q.refreshedAt,pendingCount:q.pending.length,priorityCount:q.priorityCount,hotRemaining:q.priorityCount,coldRemaining:q.coldRemaining??q.coldWithoutPrediction??0,urgentCount:q.urgentCount||0,adaptiveBatch:adaptivePredictionBatch(q),compatibility:q.compatibility||null,fingerprintCompatibility:q.fingerprintCompatibility||null,fingerprintSchemaVersion:q.fingerprintSchemaVersion??null,fingerprintPromptVersion:q.fingerprintPromptVersion??null,predictionPromptVersion:q.predictionPromptVersion??null,discovery:q.discovery||null,metrics:q.metrics||null,lastBatch:q.lastBatch,lastCheckAt:q.lastCheckAt,...scheduledRunFields()}:null;}
// AIR-389. The collection and recommendation blocks of the compact footer. Pure and read-only: they use only objects `footerStatus` already holds
// (programme, catalog, watchlist, metadata cache, view index, profile) and never write, fetch or scan anything else.
// A film is one verified canonical TMDB identity (`tmdb:<n>`); an id that no stored record links to a TMDB id stays its own film (`id:<id>`).
// Links come only from the stored ids (`catalogLidTmdb`: all records must agree, titles are never compared), so a watched film known only by an
// unlinked Letterboxd id is counted once, as itself, and is never taken for a different catalog film. Unknown is `state:'unknown'` with null counts,
// never 0.
// The identities are linked through the stored records, and the metadata cache holds links no other record has (a watched film known only by its Letterboxd id).
// So the blocks are known only when every source they read is readable: the view index, the watchlist and the metadata cache (an empty `{}` cache is readable;
// an unreadable or missing one is not, and is never taken for "nothing is linked").
function footerPlainObject(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
function footerIdentitySources({index,watchlist,metadata}){return typeof catalogLidTmdb==='function'&&footerPlainObject(index)&&Array.isArray(watchlist?.films)&&footerPlainObject(metadata);}
function footerIdentity(id,byLid){
 const key=String(id),own=/^tmdb_([1-9]\d*)$/.exec(key);
 if(own)return 'tmdb:'+own[1];
 const linked=byLid.get(key);
 return linked?'tmdb:'+linked:'id:'+key;
}
// A rating is a finite number. null, '', false and strings are not ratings (Number(null), Number('') and Number(false) are 0, a real rating's value).
function footerRating(value){return typeof value==='number'&&Number.isFinite(value);}
function footerFacts(index,byLid){
 const watched=new Set(),rated=new Set(),seed=typeof INITIAL_PERSONAL_RATINGS==='undefined'?{}:INITIAL_PERSONAL_RATINGS;
 for(const [id,item] of Object.entries(index||{})){
  const identity=footerIdentity(id,byLid);
  if(item?.watched===true)watched.add(identity);
  const rating=Object.hasOwn(item||{},'actualRating')?item.actualRating:seed[id];
  if(footerRating(rating))rated.add(identity);
 }
 // The compiled ratings seed also covers ids the index does not hold.
 for(const [id,rating] of Object.entries(seed))if(!Object.hasOwn(index||{},id)&&footerRating(rating))rated.add(footerIdentity(id,byLid));
 return {watched,rated};
}
function footerCollection({report,catalog,watchlist,index,metadata}){
 const unknown={state:'unknown',total:null,watched:null,rated:null,watchlist:null};
 // The total is a union of the programme, the catalog and the watchlist: a source that could not be read would silently shrink it.
 if(!footerIdentitySources({index,watchlist,metadata})||!footerPlainObject(report)||!footerPlainObject(catalog))return unknown;
 const byLid=catalogLidTmdb({metadata,watchlist,programme:report,catalog}),all=new Set(),listed=new Set();
 for(const film of watchlist.films){if(film?.id==null)continue;const identity=footerIdentity(film.id,byLid);listed.add(identity);all.add(identity);}
 // A programme film flagged catalog-only is a catalog film that merely airs; it is not on the watchlist.
 for(const film of report?.films||[]){if(film?.id==null)continue;all.add(footerIdentity(film.id,byLid));}
 for(const film of Object.values(catalog||{}))if(film?.tmdbId&&film.canonicalIdentity==='tmdb:'+String(film.tmdbId))all.add('tmdb:'+String(film.tmdbId));
 const facts=footerFacts(index,byLid);
 for(const identity of [...facts.watched,...facts.rated])all.add(identity);
 return {state:'ok',total:all.size,watched:facts.watched.size,rated:facts.rated.size,watchlist:listed.size};
}
// "New and interesting": a verified catalog movie outside the watchlist that the owner has neither watched nor rated, with a prediction that is current for the
// current profile and fingerprint and passes the same floor as «Находки» (rating 4.0+, chance of 4+ at least 70%, effective confidence not low). The two ranges
// do not overlap: 4.0 to 4.4 and 4.5 and above. The show window is not applied: this counts the collection, not the airing now.
function footerNewUnseen({report,catalog,watchlist,index,metadata,profile,freshness}){
 const unknown={state:'unknown',rating40to44:null,rating45plus:null};
 // Without a freshness rule nothing can be called current: that is unknown, not "no eligible film".
 // The programme films (not flagged catalog-only) are part of the exclusion, so an absent programme is an unknown membership, not an empty one.
 if(!profile||typeof freshness?.indexed!=='function'||!footerPlainObject(catalog)||!footerPlainObject(report)||!footerIdentitySources({index,watchlist,metadata}))return unknown;
 const byLid=catalogLidTmdb({metadata,watchlist,programme:report,catalog}),listed=new Set();
 for(const film of [...watchlist.films,...(report?.films||[]).filter(film=>film?.catalogOnly!==true)]){if(film?.id!=null)listed.add(footerIdentity(film.id,byLid));}
 // A recorded watchlist fact, either value, is membership: it is not a first-watch offer.
 for(const [id,item] of Object.entries(index))if(item?.watchlist===true||item?.watchlist===false)listed.add(footerIdentity(id,byLid));
 const facts=footerFacts(index,byLid),groups=new Map();
 for(const film of Object.values(catalog)){
  if(!film?.tmdbId||film.canonicalIdentity!=='tmdb:'+String(film.tmdbId))continue;
  const identity='tmdb:'+String(film.tmdbId),group=groups.get(identity)||[];group.push(film);groups.set(identity,group);
 }
 let rating40to44=0,rating45plus=0;
 for(const [identity,films] of groups){
  if(listed.has(identity)||facts.watched.has(identity)||facts.rated.has(identity))continue;
  let best=null;
  for(const film of films){
   const item=index[String(film.id)];
   if(!item?.prediction||!freshness.indexed(item,film))continue;
   const prediction=item.prediction,confidence=effectivePredictionConfidence(prediction);
   if(prediction.stale||!Number.isFinite(prediction.predictedRating)||prediction.predictedRating<4||!Number.isFinite(prediction.probability4Plus)||prediction.probability4Plus<.7||!confidence||confidence==='low')continue;
   if(best===null||prediction.predictedRating>best)best=prediction.predictedRating;
  }
  if(best===null)continue;
  if(best>=4.5)rating45plus++;else rating40to44++;
 }
 return {state:'ok',rating40to44,rating45plus};
}
// AIR-519: under the completed-only rule a film's showings are those of the completed programme for its TMDB id (withCompletedShows), so whether it airs
// in the window is decided from that list directly. The film is not copied with its showings (that copied the whole catalogue on every footer read); the
// answer is the one the overlaid copy gave: the copy kept every field but `shows`, and filmIsHot reads only `shows` of a film that has the array.
function canonicalCoverageSummary(report,catalog,index,profile,now=Date.now(),freshness=strictFreshness(profile),completedOnly=false){
 const groups=new Map();
 const completed=completedOnly&&typeof withCompletedShows==='function'&&typeof completedShowsByTmdb==='function'?completedShowsByTmdb(report):null;
 const hot=film=>{
  if(!completedOnly||typeof withCompletedShows!=='function'||completed==null||!film||typeof film!=='object')return filmIsHot(film,now);
  return filmIsHot({shows:film.tmdbId==null?[]:completed.get(String(film.tmdbId))||[]},now);
 };
 const add=film=>{
  const tmdbId=String(film?.tmdbId||'').trim();if(!tmdbId)return;
  const identity='tmdb:'+tmdbId,group=groups.get(identity)||{ids:new Set(),hot:false,byId:new Map()};
  group.ids.add(String(film.id));if(!group.hot&&hot(film))group.hot=true;if(!group.byId.has(String(film.id)))group.byId.set(String(film.id),film);groups.set(identity,group);
 };
 for(const film of report?.films||[])add(film);
 for(const film of Object.values(catalog||{}))add(film);
 let currentPredictionsTotal=0,windowFilmsTotal=0,windowCurrentPredictions=0,cacheOffWindowTotal=0,pendingOffWindowTotal=0;
 for(const group of groups.values()){
  const current=[...group.ids].some(id=>freshness.indexed(index?.[id],group.byId.get(id)));
  const inWindow=group.hot;
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
 if(!Array.isArray(queue?.hotPending)||!Array.isArray(queue?.coldPending))return {hotPending:queue?.priorityCount??null,coldPending:queue?.coldRemaining??null,outstanding:null,eligibleNow:null,deferredByRetry:null,retryExhausted:null,nextRetryAt:null};
 const outstanding=[...new Set([...queue.hotPending,...queue.coldPending])].filter(id=>!retryBudgetExhausted(queue.retries?.[id]));
 const deferred=outstanding.filter(id=>queue.retries?.[id]?.retryAt>now),nextMs=deferred.map(id=>queue.retries[id].retryAt).filter(value=>typeof value==='number').sort((a,b)=>a-b)[0];
 const retryExhausted=Object.values(queue.retries||{}).filter(retryBudgetExhausted).length;
 return {hotPending:queue.hotPending.length,coldPending:queue.coldPending.length,outstanding:outstanding.length,eligibleNow:queueReadyIds(queue,now).length,deferredByRetry:deferred.length,retryExhausted,nextRetryAt:Number.isFinite(nextMs)?new Date(nextMs).toISOString():null};
}
// `inputs` are the objects a queue rebuild of this request already read; with them nothing large is read again.
async function predictionEventSnapshot(env,queue,batchSize=null,inputs=null){
 const unreadable=new Set();
 let pinned=env;
 try{pinned=await pinEpg(env);}catch{pinned=env;}
 const safe=async key=>{try{return await loadJSON(pinned,key);}catch{unreadable.add(key);return null;}},given=inputs?.report&&inputs.profile&&inputs.index!==undefined&&inputs.catalog!==undefined,[profile,index,report,catalog,persistedQueue]=await Promise.all([given?inputs.profile:safe(profileKey),given?inputs.index:safe(ENRICHMENT_KEY+'view-index.json'),given?inputs.report:safe('programme.json'),given?inputs.catalog:safe('epg/discovered-films.json'),queue===undefined||queue===null?safe(predictionQueueKey):queue]);
 // AIR-431. A source that could not be read (a held or failing catalog) makes the coverage unknown: it is never computed from a missing catalog
 // and reported as a drop. The run, the queue slices and the delta (predictionGain null) do not depend on it.
 const coverage=unreadable.has('epg/discovered-films.json')||unreadable.has('programme.json')||unreadable.has(ENRICHMENT_KEY+'view-index.json')?null:canonicalCoverageSummary(report,catalog,index,profile,Date.now(),await predictionFreshness(env,profile),pinned?.epgPin?.authority==='d1');
 return {coverage:coverage?{...coverage,localPercent:coveragePercent(coverage.currentPredictionsTotal,coverage.confirmedFilmsTotal),windowPercent:coveragePercent(coverage.windowCurrentPredictions,coverage.windowFilmsTotal)}:null,queue:predictionQueueSlices(persistedQueue),...(Number.isInteger(batchSize)&&batchSize>0?{currentBatchSize:batchSize}:{})};
}
function predictionEventDelta(run,summary,snapshot){const current=snapshot?.coverage?.currentPredictionsTotal,start=run.coverageStartCurrentPredictions;return {added:summary.added,updated:summary.updated,failed:summary.failed,predictionGain:Number.isInteger(current)&&Number.isInteger(start)?current-start:null};}
const INTEGRATION_STALE_MS=48*3600000;
function integrationTime(value){const ms=Date.parse(value);return Number.isFinite(ms)?new Date(ms).toISOString():null;}
// Owner-facing “программа обновлена”: the successful end of the published run (`completedAt` / complete `sync.json`
// `updatedAt`), the same instant the `epg` event stores as `at`. Not scan `report.updatedAt`, not `startedAt`/`dueAt`,
// not D1 `published_epg_generation.published_at` (that column still copies the scan clock at pointer switch). An
// in-flight or failed later run keeps `lastEpgPublishedAt` from the last complete record. Missing or invalid → null.
//
// AIR-518: the one read model of the published EPG generation, shared by `/api/programme` `publishedAt`, the header, the
// footer EPG health and the EPG events/status reads. Publication and the last attempt are separate facts:
// - the completion receipt is `stage: complete` with a valid `completedAt` (set by `prepareEpgCompletion` only once the run
//   has passed its pointer switch and every seal phase), or, for a record written before AIR-390, a complete `updatedAt`
//   without an error;
// - the receipt counts for the published generation only when its runId is that generation's runId (`report` is the
//   pinned published programme). A different runId, a missing receipt or an unreadable time never becomes a success;
// - an `error` kept on a complete record is a failed earlier attempt of the same run that a retry recovered (the seal
//   step stores the error and the successful retry does not clear it). It is reported as `attempt.outcome: recovered`
//   and never makes the published generation failed. Without a readable generation (no `report` / no `runId`) or
//   without `sync.runId` no record is proven and the surfaces stay unknown (`epg_unproven`).
// The start's carried `lastEpgPublishedAt` is a separate, explicitly unbound helper (`epgCarriedPublishedAt`).
const EPG_RUNNING_STAGES=['metadata','epg','seal'];
function epgErrorCode(message){const text=String(message||'');return /HTTP/i.test(text)?'epg_http':/cover the current window/i.test(text)?'epg_window':/parse|xml|unexpected/i.test(text)?'epg_parse':'epg_failed';}
// The completion receipt: a valid `completedAt`, or, only for a record written before AIR-390 (no `completedAt` field at all),
// a complete `updatedAt` without an error. A present but invalid `completedAt` (null included) is never replaced by `updatedAt`.
function epgCompletionReceipt(sync){
 if(sync?.stage!=='complete')return null;
 if(Object.prototype.hasOwnProperty.call(sync,'completedAt'))return integrationTime(sync.completedAt);
 return sync.error?null:integrationTime(sync.updatedAt);
}
// The published-generation contract of every UI surface: success needs the receipt AND both runIds, non-empty and equal
// (`report` is the pinned published programme). An absent or unreadable programme, a missing `sync.runId` or another
// runId never credits the record; those surfaces then show the last proven (carried) date with an unproven state.
function epgPublicationState(sync,report){
 const receipt=epgCompletionReceipt(sync),reportRunId=typeof report?.runId==='string'&&report.runId?report.runId:null,runId=typeof sync?.runId==='string'&&sync.runId?sync.runId:null,error=sync?.error?String(sync.error):null;
 const bound=!!receipt&&!!reportRunId&&reportRunId===runId;
 const carried=integrationTime(sync?.lastEpgPublishedAt);
 const publishedAt=bound?receipt:carried;
 let attempt;
 if(bound)attempt=error?{outcome:'recovered',code:epgErrorCode(error),at:null}:{outcome:'complete',code:null,at:receipt};
 else if(sync?.stage==='complete'&&(receipt||!error))attempt={outcome:'unproven',code:error?epgErrorCode(error):null,at:null};
 else if(error)attempt={outcome:'failed',code:epgErrorCode(error),at:integrationTime(sync.updatedAt)};
 else if(sync&&EPG_RUNNING_STAGES.includes(sync.stage))attempt={outcome:'running',code:null,at:integrationTime(sync.updatedAt)};
 else attempt={outcome:'unknown',code:null,at:null};
 return {publishedAt,runId:bound?runId:reportRunId,binding:bound?'run':publishedAt?'carried':'none',attempt};
}
function epgUxPublishedAt(sync,report){return epgPublicationState(sync,report).publishedAt;}
// Not a UI contract: the timestamp a new run carries forward as `lastEpgPublishedAt` at start, from the previous record
// alone (no published programme is read there). The previous run's own receipt, else what it carried. Explicitly unbound;
// the UI surfaces above still bind every date they show to the published runId.
function epgCarriedPublishedAt(sync){return epgCompletionReceipt(sync)||integrationTime(sync?.lastEpgPublishedAt);}
function integrationEntry(id,role,state,code,lastSuccessAt,lastFailureAt){return {id,role,state,code,lastSuccessAt:lastSuccessAt||null,lastFailureAt:lastFailureAt||null};}
function ratingsFailureCode(kind){if(kind==='blocked'||kind==='anti_bot')return 'ratings_blocked';if(kind==='http_429')return 'ratings_rate_limit';if(kind==='degraded'||kind==='incomplete')return 'ratings_incomplete';if(kind==='lookup_failed'||kind==='publish_failed'||kind==='failed')return 'ratings_failed';return null;}
function ratingsMessageCode(message){if(/403|anti-bot/i.test(message))return 'ratings_blocked';if(/429/.test(message))return 'ratings_rate_limit';if(/incomplete|pagination changed|duplicate letterboxd/i.test(message))return 'ratings_incomplete';return 'ratings_failed';}
function resolverMatches(programmeRunId,reportRunId){if(!programmeRunId||!reportRunId)return true;return programmeRunId===reportRunId;}
const PREDICTION_HARD_STOP=new Set(['quota','storage_error','model_error','model_unavailable','api_error','format_error_storm']);
// AIR-556. One progress policy for the Footer (predictionCapabilityHealth) and the Cloudflare Monitor (monitor.js), so they cannot disagree.
// Four external Tasks are expected per hour (nominally :00/:15/:30/:45, about +-7 min of scheduler drift), so two consecutive Task starts are at
// most about 29 min apart and a productive batch is expected well inside an hour. With eligible work and no productive batch (or confirmed
// empty-queue check) for this long, the Worker has no confirmed prediction progress. It says nothing about why: a Task that never reached the
// Worker leaves no record here, so this never claims api_error, an expired MCP authorization or a count of missed Tasks.
const PREDICTION_NO_PROGRESS_MS=60*60000;
// A run whose lease is still live counts as running for this long; past it the run is not evidence of progress and the clock above decides.
const PREDICTION_ACTIVE_RUN_MAX_MS=60*60000;
const predictionProgressStalled=ageMs=>ageMs==null||ageMs>=PREDICTION_NO_PROGRESS_MS;
// ADR 0193 / AIR-573. The same verdict, earlier, when the silence is not quiet but a chain of ownerless starts: attempts turned away with `already_running` and runs that were abandoned without a single
// film, all since the last confirmed progress. Three such attempts and at least 20 minutes without progress are repeated orphan starts; one overlap between two Tasks, or a run that is still working, is not.
// It is one more reason of the one shared verdict (Footer and Monitor), not a second monitor.
const PREDICTION_ORPHAN_START_LIMIT=3;
const PREDICTION_ORPHAN_MIN_IDLE_MS=20*60000;
const PREDICTION_ORPHAN_WINDOW_MS=2*60*60000;
// The pure verdict both surfaces rely on. `sinceMs` is the last confirmed progress (a productive batch, or a drained run that proved an empty
// queue); heartbeat, `already_running`, a queue recount and a noop wake-up are never passed as progress. Unknown input is `unknown`, never healthy.
// AIR-596 (ADR 0210): a proven verdict (the 60-minute limit or repeated orphan starts, both measured from the last confirmed progress) is decided BEFORE the live
// run. A current lease, a start, a manifest read, a heartbeat, `already_running` or a new runId is not progress, so a young live run never hides a silence that is
// already proven; it only keeps `running` while nothing is proven (fresh progress, or no evidence at all yet). `orphanStarts` is reported with every verdict.
function predictionStallAssessment({now,sinceMs=null,eligibleNow=null,nextRetryAtMs=null,activeStartedAtMs=null,activeRun=false,observedSinceMs=null,orphanStarts=0}){
 if(!Number.isInteger(eligibleNow))return {state:'unknown',reason:'queue_unreadable',idleMs:null};
 if(eligibleNow===0)return {state:Number.isFinite(nextRetryAtMs)&&nextRetryAtMs>now?'waiting':'idle',reason:eligibleNow===0?'no_eligible_work':null,idleMs:null};
 // An unknown start is not trusted as young: a lease without a provable start never hides a long silence.
 const young=activeRun&&Number.isFinite(activeStartedAtMs)&&now-activeStartedAtMs<PREDICTION_ACTIVE_RUN_MAX_MS;
 const known=Number.isFinite(sinceMs);
 const base=known?sinceMs:Number.isFinite(observedSinceMs)?observedSinceMs:null;
 const orphans=Number.isInteger(orphanStarts)&&orphanStarts>0?orphanStarts:0;
 if(base===null)return young?{state:'running',reason:'active_run',idleMs:null}:{state:'unknown',reason:'no_progress_evidence',idleMs:null};
 const idleMs=Math.max(0,now-base);
 if(orphans>=PREDICTION_ORPHAN_START_LIMIT&&idleMs>=PREDICTION_ORPHAN_MIN_IDLE_MS)return {state:'no_progress',reason:'repeated_orphan_starts',idleMs,sinceKnown:known,orphanStarts:orphans,activeRun:!!activeRun};
 if(predictionProgressStalled(idleMs))return {state:'no_progress',reason:known?'no_productive_batch':'no_progress_evidence',idleMs,sinceKnown:known,orphanStarts:orphans,activeRun:!!activeRun};
 if(young)return {state:'running',reason:'active_run',idleMs,sinceKnown:known};
 return {state:known?'ok':'unknown',reason:known?null:'no_progress_evidence',idleMs,sinceKnown:known};
}
// AIR-556 review: only the two reasons whose completion re-read the queue and found no ready film prove an empty (or fully deferred) queue. `manifest_spent`
// only says the selected manifest was settled (including `already_current`), and `retry_backoff` is a noop with work remaining: neither is progress.
const PREDICTION_DRAINED=new Set(['queue_empty','eligible_queue_empty']);
function predictionRunFact(row,now){
 if(!row||typeof row!=='object')return null;
 const reason=row.stopReason||row.reason||null;
 // A run record carries its counts in `counts` (created/recalculated) once completed, a diagnostic in `added`/`updated`; else they are counted from `results`.
 const added=Number.isInteger(row.added)?row.added:Number.isInteger(row.counts?.created)?row.counts.created:Object.values(row.results||{}).filter(value=>value==='created').length;
 const updated=Number.isInteger(row.updated)?row.updated:Number.isInteger(row.counts?.recalculated)?row.counts.recalculated:Object.values(row.results||{}).filter(value=>value==='recalculated').length;
 const failed=Number.isInteger(row.failed)?row.failed:Object.keys(row.failures||{}).length;
 const status=row.status||row.state||null;
 const startedAt=integrationTime(row.startedAt||row.createdAt||row.diagnosticStartedAt);
 const endedAt=integrationTime(row.endedAt||row.completedAt||row.finishedAt);
 // AIR-596: the first committed film of a run still working dates its progress better than its start (the commit happened at or after it, never before).
 const firstSubmitAt=integrationTime(row.firstSubmitAt);
 return {runId:row.runId||null,status,reason,added,updated,failed,startedAt,endedAt,firstSubmitAt,at:endedAt||startedAt,startResult:typeof row.startResult==='string'?row.startResult:null};
}
function predictionFactMs(fact){const at=integrationTime(fact?.endedAt||fact?.startedAt||fact?.at);return at?Date.parse(at):NaN;}
// When a progress fact proved progress, never later than a commit (AIR-596 review): a completed run at its completion (which settles its films in the
// same write and proves the drained queue); any other productive run (still working, interrupted, expired, partial) at its first committed film, else at
// its start, a conservative lower bound. Its end is never used: for an expired run it is the lease expiry that `projectedDiagnostic` fills in, not a commit.
function predictionProgressTime(fact){
 if(!fact)return null;
 const complete=fact.status==='complete'||fact.status==='completed';
 return integrationTime((complete&&fact.endedAt)||fact.firstSubmitAt||fact.startedAt);
}
// A valid progress time: parseable and not in the future beyond the clock skew every reader allows (5 minutes).
const predictionValidProgressMs=(value,now)=>{const ms=Date.parse(value||'');return Number.isFinite(ms)&&ms<=now+300000?ms:null;};
// The run history as the Footer and the Monitor both read it: normalized facts newest first and the classifiers that decide what counts as progress.
// Progress is a productive batch (films created or recalculated) or a drained run (a complete run that found nothing eligible, which proves the queue
// was empty at that time). A heartbeat, `already_running`, a noop wake-up, a failed-only run and a queue recount are not progress.
function predictionRunEvidence({run,recentRuns,now}){
 const facts=[];
 const seen=new Set();
 // The same run can arrive as a diagnostic checkpoint and as latest-run.json. A checkpoint written before `updated` existed has no recalculation count, so the
 // two are merged by run id: counts take the larger value and a missing end time is filled, never dropped in favour of whichever arrived first.
 const byRun=new Map();
 const push=row=>{
  const fact=predictionRunFact(row,now);if(!fact||!fact.runId)return;
  const known=byRun.get(fact.runId);
  if(!known){seen.add(fact.runId);byRun.set(fact.runId,fact);facts.push(fact);return;}
  known.added=Math.max(known.added||0,fact.added||0);known.updated=Math.max(known.updated||0,fact.updated||0);known.failed=Math.max(known.failed||0,fact.failed||0);
  if(!known.endedAt&&fact.endedAt){known.endedAt=fact.endedAt;known.at=fact.endedAt;}
  if(!known.reason&&fact.reason)known.reason=fact.reason;
  if(!known.status&&fact.status)known.status=fact.status;
  if(!known.startResult&&fact.startResult)known.startResult=fact.startResult;
  if(!known.firstSubmitAt&&fact.firstSubmitAt)known.firstSubmitAt=fact.firstSubmitAt;
 };
 for(const row of recentRuns||[])push(row);
 push(run);
 facts.sort((a,b)=>(Date.parse(b.at||0)-Date.parse(a.at||0))||String(b.runId).localeCompare(String(a.runId)));
 const isHard=fact=>PREDICTION_HARD_STOP.has(fact.reason);
 const isComplete=fact=>fact.status==='complete'||fact.status==='completed';
 const isDrained=fact=>isComplete(fact)&&PREDICTION_DRAINED.has(fact.reason)&&(fact.failed||0)===0;
 const isProgress=fact=>(fact.added||0)>0||(fact.updated||0)>0||isDrained(fact);
 const isFailedOnly=fact=>isComplete(fact)&&(fact.added||0)===0&&(fact.updated||0)===0&&(fact.failed||0)>0;
 const isInterrupt=fact=>{
  if(!fact||isHard(fact)||isProgress(fact)||isFailedOnly(fact))return false;
  if(['partial','blocked','interrupted'].includes(fact.status))return true;
  if(fact.status==='running')return true;
  return ['external_termination','lease_expired','lease_lost','time_budget','already_running','runner_aborted'].includes(fact.reason);
 };
 // The latest progress by its own progress time (not by the run order, which sorts on the end or start): invalid and future times are left out.
 let lastProgress=null,lastProgressMs=null;
 for(const fact of facts){if(!isProgress(fact))continue;const ms=predictionValidProgressMs(predictionProgressTime(fact),now);if(ms!==null&&(lastProgressMs===null||ms>lastProgressMs)){lastProgress=fact;lastProgressMs=ms;}}
 // Ownerless starts since the last confirmed progress, inside a bounded window: a start turned away with `already_running`, or a run abandoned without a film (a run still `running` is working, not abandoned).
 const orphanStarts=predictionOrphansAfter({facts,isProgress,isInterrupt},lastProgressMs??-Infinity,now);
 return {facts,isHard,isComplete,isDrained,isProgress,isFailedOnly,isInterrupt,lastProgress,orphanStarts,lastProgressAt:predictionProgressTime(lastProgress)};
}
// AIR-596 (ADR 0210). The durable progress clock, independent of the bounded run history (the Footer reads 8 diagnostics, the Monitor 20: a series of
// ownerless starts evicts the last productive run within hours). Two stored facts, both written at the commit itself and never by a read:
// - `queue.lastBatch`, written by the completion of a run in the same conditional write that settles its films and carried unchanged by every queue
//   rebuild, recount or import. It counts only when it names a run that created or recalculated films (its own `finishedAt`), or a completion or empty-queue
//   check that left nothing pending. A noop or retry-backoff wake-up (`runId: null`, nothing saved), `manifest_spent` with nothing saved and a failed-only batch are not progress.
// - the Monitor's stored clock (`monitor/state.json` `predictions.progressAt` with `progressBasis: evidence`): the last progress time the hourly tick derived
//   from these same facts, so a success evicted from the history is not forgotten. It is a past event time, so an old value only makes the verdict stricter.
// The moved `hotProcessedTotal` counter is not a progress time: it says a run completed since the previous tick, not when.
function predictionLastBatchProgressAt(queue,now=Date.now()){
 const batch=queue&&typeof queue==='object'?queue.lastBatch:null;
 if(!batch||typeof batch!=='object')return null;
 const at=integrationTime(batch.finishedAt),ms=Date.parse(at||'');
 if(!Number.isFinite(ms)||ms>now+300000)return null;
 const saved=(Number.isInteger(batch.added)?batch.added:0)+(Number.isInteger(batch.updated)?batch.updated:0);
 if(batch.runId&&saved>0)return at;
 const drained=Number.isInteger(batch.remaining)&&batch.remaining===0&&!(batch.failed>0)&&(batch.stage==='noop'||(!!batch.runId&&batch.stage==='complete'));
 return drained?at:null;
}
function predictionStoredClockAt(clock,now=Date.now()){
 if(!clock||typeof clock!=='object'||clock.progressBasis!=='evidence')return null;
 const at=integrationTime(clock.progressAt),ms=Date.parse(at||'');
 return Number.isFinite(ms)&&ms<=now+300000?at:null;
}
// The Monitor's persisted start of an unknown-age silence (`unknownSince`, ADR 0182 decision 3): the one observation basis both surfaces use when no
// progress time is known. The Footer falls back to its own oldest recorded attempt only when the Monitor has none.
function predictionStoredUnknownSince(clock,now=Date.now()){const at=integrationTime(clock&&typeof clock==='object'?clock.unknownSince:null);return predictionValidProgressMs(at,now)===null?null:at;}
// Eligible work as both surfaces judge it: the runner's lane rule (`predictionQueueSlices`), and zero only when it is proven. A queue whose lanes cannot be
// read is unknown (null), never healthy, unless its `pending` list itself is an empty array (nothing outstanding at all).
function predictionEligibleNow(queue,slices){
 if(Number.isInteger(slices?.eligibleNow))return slices.eligibleNow;
 return Array.isArray(queue?.pending)&&queue.pending.length===0?0:null;
}
function predictionLatestAt(...values){return values.filter(value=>Number.isFinite(Date.parse(value||''))).sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1)||null;}
// What the Monitor needs from the queue, the lease and the run history, read through the same helpers the Footer uses (queue slices, retry budget).
function predictionProgressFacts({queue,runs,latestRun,lease,now}){
 const slices=predictionQueueSlices(queue,now);
 const evidence=predictionRunEvidence({run:latestRun,recentRuns:runs,now});
 const activeRun=!!(lease&&lease.runId&&Number.isFinite(lease.expiresAt)&&lease.expiresAt>now);
 // The start of the run that holds the lease: its own record, else its diagnostic checkpoint; a lease for another or an unreadable run has no provable start.
 const owned=activeRun?(latestRun?.runId===lease.runId?latestRun.createdAt:(runs||[]).find(row=>row?.runId===lease.runId)?.startedAt):null;
 const startedMs=Date.parse(owned||'');
 // AIR-596: the queue's own last batch is durable evidence beside the bounded history; the orphan count still comes from the history after that progress.
 const lastBatchAt=predictionLastBatchProgressAt(queue,now),lastProgressAt=predictionLatestAt(evidence.lastProgressAt,lastBatchAt);
 const orphanStarts=predictionOrphansAfter(evidence,lastProgressAt?Date.parse(lastProgressAt):-Infinity,now);
 return {slices,eligibleNow:predictionEligibleNow(queue,slices),lastProgressAt,historyProgressAt:evidence.lastProgressAt,lastBatchProgressAt:lastBatchAt,orphanStarts,activeRun,activeStartedAtMs:Number.isFinite(startedMs)?startedMs:null,runHistoryEmpty:!evidence.facts.length};
}
// The ownerless starts of the history newer than a progress time that came from outside it (the durable clock), under the same rule as predictionRunEvidence.
function predictionOrphansAfter(evidence,progressMs,now){
 return evidence.facts.filter(fact=>{const at=predictionFactMs(fact);return Number.isFinite(at)&&at>progressMs&&now-at<=PREDICTION_ORPHAN_WINDOW_MS&&!evidence.isProgress(fact)&&(fact.startResult==='already_running'||(evidence.isInterrupt(fact)&&fact.status!=='running'&&(fact.added||0)===0&&(fact.updated||0)===0));}).length;
}
// AIR-596 (ADR 0210): the Footer's verdict is the shared assessment above, fed with the same durable clock as the Monitor (the history, the queue's last batch
// and the Monitor's stored clock). A proven no-progress verdict wins over a live lease, so «нет подтверждённого прогресса прогнозов» and the last confirmed success
// stay visible while Tasks keep starting runs that never commit; the run line still says «выполняется» (operational state, not health).
function predictionCapabilityHealth({run,live,now,recentRuns,queue,clock=null}){
 const age=value=>{const at=integrationTime(value);return at?now-Date.parse(at):null;};
 const fresh=value=>age(value)>INTEGRATION_STALE_MS?'stale':'healthy',freshCode=value=>fresh(value)==='stale'?'stale':'ok';
 const evidence=predictionRunEvidence({run,recentRuns,now});
 const {facts,isHard,isFailedOnly,isInterrupt}=evidence;
 const slices=predictionQueueSlices(queue,now),eligibleNow=predictionEligibleNow(queue,slices);
 const workLeft=Number.isInteger(eligibleNow)&&eligibleNow>0;
 const lastSuccessAt=predictionLatestAt(evidence.lastProgressAt,predictionLastBatchProgressAt(queue,now),predictionStoredClockAt(clock,now));
 const startedMs=live?Date.parse(run?.createdAt||''):NaN,liveYoung=Number.isFinite(startedMs)&&now-startedMs<PREDICTION_ACTIVE_RUN_MAX_MS;
 const latest=facts[0]||null;
 const lastHard=facts.find(isHard);
 const lastFailureAt=latest?integrationTime(latest.endedAt||latest.startedAt):null;
 const successMs=lastSuccessAt?Date.parse(lastSuccessAt):null;
 const hardUnresolved=!!lastHard&&(successMs===null||predictionFactMs(lastHard)>=successMs);
 const hardFailureAt=hardUnresolved?integrationTime(lastHard.endedAt||lastHard.startedAt)||lastFailureAt:null;
 // No progress time at all: the same observation basis as the Monitor (its persisted `unknownSince`), else the oldest recorded attempt here.
 const oldest=facts[facts.length-1],oldestMs=Date.parse(oldest?.startedAt||oldest?.at||'');
 const storedSince=predictionStoredUnknownSince(clock,now);
 const observedSinceMs=successMs!==null?null:storedSince?Date.parse(storedSince):Number.isFinite(oldestMs)?oldestMs:null;
 const orphanStarts=predictionOrphansAfter(evidence,successMs??-Infinity,now);
 const stall=predictionStallAssessment({now,sinceMs:successMs,eligibleNow,nextRetryAtMs:slices.nextRetryAt?Date.parse(slices.nextRetryAt):null,activeRun:!!live,activeStartedAtMs:Number.isFinite(startedMs)?startedMs:null,observedSinceMs,orphanStarts});
 // An unreadable split is unknown health (ADR 0182 decision 4), whatever the run line says: never running, never healthy from an earlier success. A proven hard stop stays proven.
 if(stall.state==='unknown'&&stall.reason==='queue_unreadable')return hardUnresolved?integrationEntry('predictions','capability','degraded','prediction_blocked',lastSuccessAt,hardFailureAt):integrationEntry('predictions','capability','unknown','no_data',lastSuccessAt,lastFailureAt);
 if(stall.state==='no_progress')return integrationEntry('predictions','capability','degraded',hardUnresolved?'prediction_blocked':'prediction_no_recent_progress',lastSuccessAt,hardUnresolved?hardFailureAt:lastFailureAt);
 // Nothing is proven: a live run younger than the limit is working (one overlap or a start is not an outage).
 if(liveYoung&&stall.state!=='unknown')return integrationEntry('predictions','capability','running','running',null,null);
 if(!latest&&!lastSuccessAt)return integrationEntry('predictions','capability','unknown','no_data',null,null);
 if(!latest)return integrationEntry('predictions','capability',fresh(lastSuccessAt),freshCode(lastSuccessAt),lastSuccessAt,null);
 let consecutiveInterrupts=0;
 for(const fact of facts){if(isInterrupt(fact))consecutiveInterrupts++;else break;}
 if(hardUnresolved)return integrationEntry('predictions','capability','degraded','prediction_blocked',lastSuccessAt,hardFailureAt);
 if(consecutiveInterrupts>=2&&workLeft)return integrationEntry('predictions','capability','degraded','prediction_runs_interrupted',lastSuccessAt,lastFailureAt);
 if(workLeft&&!lastSuccessAt){
  if(facts.filter(fact=>isInterrupt(fact)).length>=2)return integrationEntry('predictions','capability','degraded','prediction_no_recent_progress',null,lastFailureAt);
  return integrationEntry('predictions','capability','unknown','no_data',null,lastFailureAt);
 }
 // AIR-556: item failures of a completed batch (parse, validation, retry) are expected and live in lastRun.failed and the item diagnostics. They are not pipeline health:
 // health comes from confirmed progress (60 minutes), a hard stop, or repeated interruptions, never from a failure count alone.
 if(lastSuccessAt)return integrationEntry('predictions','capability',fresh(lastSuccessAt),freshCode(lastSuccessAt),lastSuccessAt,isInterrupt(latest)||isFailedOnly(latest)?lastFailureAt:null);
 return integrationEntry('predictions','capability','unknown','no_data',null,lastFailureAt);
}
// ADR 0179 / AIR-543: the weekly poster source. One projection of the B1 checkpoint (CatalogPosterWeekly.readStatus); absent evidence is never healthy.
const POSTER_STATE_MAP={healthy_idle:['healthy','poster_idle'],grace:['waiting','poster_first_run'],waiting:['waiting','poster_retry_scheduled'],overdue:['degraded','poster_overdue'],stalled:['degraded','poster_stalled'],lost:['degraded','poster_lost'],failed:['failed','poster_failed'],unknown:['unknown','no_data']};
function posterIntegration(projection){
 const state=projection&&typeof projection==='object'?projection.state:null,mapped=POSTER_STATE_MAP[state];
 if(!mapped)return {...integrationEntry('posters','source','unknown','no_data',null,null),freshnessAt:null,lastWeek:null,nextAttemptAt:null};
 const summary=projection.summary&&typeof projection.summary==='object'?projection.summary:null,count=value=>Number.isInteger(value)&&value>=0?value:null;
 const code=state==='healthy_idle'&&summary?.hydrated>0?'poster_hydrated':mapped[1];
 const completed=projection.lastOutcome?.status==='completed'&&state==='healthy_idle',freshness=integrationTime(projection.freshnessAt);
 const failedAt=state==='failed'?freshness:null;
 return {...integrationEntry('posters','source',mapped[0],code,completed?freshness:null,failedAt),freshnessAt:freshness,lastWeek:summary?{weekStart:projection.lastOutcome?.weekStart??null,checked:count(summary.checked),hydrated:count(summary.hydrated),noPoster:count(summary.noPoster),pending:count(summary.pending)}:null,nextAttemptAt:integrationTime(projection.nextExpectedAt)};
}
// AIR-593. The canonical Producer («Обогащение каталога»): the Monitor's own verdict (MonitorPolicy.evaluateCanonicalProducer) over the facts of the shared
// bounded reader, mapped to the footer vocabulary. `view` is {facts, verdict} or null (the read could not be made). Nothing here decides health on its own:
// `status` is the Monitor's `facts.status` (or `unreadable`), so the Footer and the Monitor cannot disagree on the same facts. No programme run id, run key,
// cursor or raw stop code leaves this function; a stop is reported by its recovery class only. Counts are processing units of the Producer, not films.
const PRODUCER_STOP_REASONS=['identity','transient','receipt','authority','terminal','fail_closed','exhausted'];
function producerIntegration(view){
 const facts=view?.facts,verdict=view?.verdict;
 const status=!facts||facts.error||facts.readable===false||!verdict?'unreadable':verdict.facts?.status||'unreadable';
 const count=value=>Number.isInteger(value)&&value>=0?value:null;
 const run=facts&&!facts.error?facts.run:null,chain=facts&&!facts.error?facts.chain:null;
 const stopCode=chain?.ownerState==='stopped'?chain.stoppedBy:run?.passState==='stopped'?run.stoppedBy:null;
 const reasonOf=()=>{
  if(!stopCode&&!['failed','blocked'].includes(status))return null;
  if(/^producer_identity_/.test(String(stopCode||'')))return 'identity';
  const klass=chain?.ownerState==='stopped'?chain.recoveryClass:null;
  return PRODUCER_STOP_REASONS.includes(klass)?klass:'fail_closed';
 };
 const passing=run?.passState==='passing';
 const mapped={current:['healthy','producer_current'],waiting:[passing?'running':'waiting',facts?.label?(passing?'producer_running':'producer_waiting'):'producer_no_publication'],
  lagging:[passing?'running':'waiting','producer_lagging'],stalled:['degraded','producer_stalled'],failed:['failed','producer_failed'],blocked:['failed','producer_blocked'],
  held_by_delivery:['degraded','producer_held'],unconfirmed:['unknown','producer_unconfirmed'],unreadable:['unknown','producer_unreadable']}[status]||['unknown','producer_unreadable'];
 const readable=status!=='unreadable'&&status!=='held_by_delivery';
 const lastSuccessAt=status==='current'?integrationTime(run?.completedAt):null;
 const reason=readable?reasonOf():null;
 return {...integrationEntry('canonical_producer','capability',mapped[0],mapped[1],lastSuccessAt,null),status,
  generation:readable&&Number.isInteger(facts?.generation)?facts.generation:null,publishedAt:readable?integrationTime(facts?.publishedAt):null,
  progressAt:readable?integrationTime(facts?.progressAt):null,processed:readable?count(run?.processed):null,unitCount:readable?count(run?.unitCount):null,failedUnits:readable?count(run?.failed):null,
  clockState:facts&&!facts.error&&typeof facts.clockState==='string'?facts.clockState:null,
  reason,nextAttemptAt:reason&&status==='failed'?integrationTime(chain?.nextAttemptAt):null,noProgressHours:status==='stalled'&&Number.isFinite(verdict?.facts?.noProgressHours)?verdict.facts.noProgressHours:null};
}
// The footer's one Producer read: the shared Monitor reader (three indexed D1 statements, nothing while the delivery hold is on) with the clock the Monitor
// stored in monitor/state.json, judged by the reader verdict of the same policy. The clock is only read, never written, and a read never dates progress by
// itself: a missing, stale or unreadable clock cannot renew the no-progress window or restore a first-tick grace (MonitorPolicy.canonicalProducerClock,
// readOnly). Answers undefined where the Producer, the Monitor or D1 is not part of this Worker (the row is then absent, as for posters).
async function footerProducerView(env,readMonitorState,now){
 const state=await Promise.resolve().then(readMonitorState).then(doc=>({readable:true,doc}),()=>({readable:false,doc:null}));
 const stored=state.doc?.canonicalProducer&&typeof state.doc.canonicalProducer==='object'?state.doc.canonicalProducer:null;
 const facts=await Monitor.canonicalProducerFacts(env,now,stored,{readOnly:true,previousReadable:state.readable});
 if(facts===null)return undefined;
 return {facts,verdict:facts.error?null:MonitorPolicy.evaluateCanonicalProducerReader(facts,now)};
}
function integrationHealth({posters,producer,sync,ratings,enabled,report,continuation,discoveryStatus,discoveryQueue=null,run,live,now,watchlistIngest,ratingsRun=null,ratingsBlocked=null,recentRuns=null,queue=null,predictionClock=null}){
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
  // Under the permanent separate pipeline (ADR 0074) the ratings run record decides once migration is complete.
  // An incomplete migration is fail-closed: the EPG commit's old rating fields do not stand in for a Diary read.
  if(ratingsBlocked)return entry('degraded','ratings_storage_unsupported',null,null,{pipeline:'blocked',storage:ratingsBlocked.storage});
  if(ratingsRun)return ratingsRun.state==='ok'?entry(fresh(ratingsRun.lastSuccessAt),freshCode(ratingsRun.lastSuccessAt),ratingsRun.lastSuccessAt,ratingsRun.lastFailureAt,{pipeline:'separate'}):entry(ratingsRun.state,ratingsRun.code,ratingsRun.lastSuccessAt,ratingsRun.lastFailureAt,{pipeline:'separate'});
  if(ratingPending&&(!latestRating||latestRating.ok&&(!pendingSince||Date.parse(latestRating.at)<=Date.parse(pendingSince))))return entry('degraded','ratings_pending',ratingSuccess,ratingFailureAt,{pendingSince});
  if(!latestRating)return entry('unknown','no_data',null,null);
  if(!latestRating.ok)return entry(latestRating.code==='ratings_failed'?'failed':'degraded',latestRating.code,ratingSuccess,ratingFailureAt);
  return entry(fresh(ratingSuccess),freshCode(ratingSuccess),ratingSuccess,ratingFailureAt);
 })();
 const epgPublication=epgPublicationState(sync,report),epgSuccess=epgPublication.publishedAt,epgAttempt=epgPublication.attempt;
 const epg=(()=>{
  const entry=(...args)=>({...integrationEntry('epg','source',...args),runId:epgPublication.runId});
  if(epgAttempt.outcome==='complete')return entry(fresh(epgSuccess),freshCode(epgSuccess),epgSuccess,null);
  if(epgAttempt.outcome==='recovered')return {...entry(fresh(epgSuccess),freshCode(epgSuccess),epgSuccess,null),lastAttempt:{outcome:'recovered',code:epgAttempt.code}};
  if(epgAttempt.outcome==='failed')return entry('failed',epgAttempt.code,epgSuccess,epgAttempt.at);
  if(epgAttempt.outcome==='running'){const elapsed=age(sync.updatedAt);return elapsed!=null&&elapsed<15*60000?entry('running','running',epgSuccess,null):entry('degraded','epg_failed',epgSuccess,integrationTime(sync.updatedAt));}
  if(epgAttempt.outcome==='unproven')return entry('unknown','epg_unproven',epgSuccess,null);
  return entry('unknown','no_data',epgSuccess,null);
 })();
 const reportRunId=report?.runId||null,resolverConfirmed=[];
 if(discoveryStatus?.stage==='complete'&&!discoveryStatus.error){const at=integrationTime(discoveryStatus.finishedAt||discoveryStatus.at);if(at)resolverConfirmed.push({at,current:resolverMatches(discoveryStatus.programmeRunId,reportRunId)});}
 if(continuation?.stage==='complete'){const at=integrationTime(continuation.at);if(at)resolverConfirmed.push({at,current:resolverMatches(continuation.programmeRunId,reportRunId)});}
 const byTime=(a,b)=>Date.parse(a)-Date.parse(b),priorResolverSuccess=resolverConfirmed.map(item=>item.at).sort(byTime).at(-1)||null;
 const resolverProgress=()=>{const elapsed=age(continuation?.at);return integrationEntry('resolver','source',elapsed>INTEGRATION_STALE_MS?'stale':'running',elapsed>INTEGRATION_STALE_MS?'stale':'running',priorResolverSuccess,null);};
 // A chunk_budget backlog (the shared classification says work is owed) is a discovery wait gate, not a live writer. Waiting is not attention. The stall code
 // means a same-generation batch was stored and none newer than the gate was. A missing status, an unusable
 // checkpoint or batch time, or a batch from another generation is unknown evidence, not that code, and the
 // code never asserts an external usage quota or a ChatGPT Task miss. AIR-598: whether work is owed and eligible comes only from the shared
 // classification (`discoveryQueue`), never from a ledger count: a series proven drained never reaches this function.
 const q=discoveryQueue&&typeof discoveryQueue==='object'?discoveryQueue:null;
 const chunkBudgetRecognition=()=>{
  const skew=5*60*1000,skewed=value=>Number.isFinite(value)&&value>now+skew;
  const checkpoint=integrationTime(continuation?.at),checkpointMs=checkpoint?Date.parse(checkpoint):NaN,gate=integrationTime(continuation?.nextCatchUpAt),gateMs=gate?Date.parse(gate):NaN;
  const batchAt=integrationTime(discoveryStatus?.finishedAt),batchMs=batchAt?Date.parse(batchAt):NaN;
  const pinned=continuation?.programmeRunId,published=reportRunId,sameGeneration=!!(pinned&&published&&pinned===published);
  const statusGeneration=discoveryStatus?.programmeRunId,batchSameGeneration=!!(statusGeneration&&pinned&&published&&statusGeneration===pinned&&statusGeneration===published);
  const later=(a,b)=>[a,b].filter(Boolean).sort((x,y)=>Date.parse(x)-Date.parse(y)).at(-1)||null;
  const success=later(priorResolverSuccess,checkpoint&&!skewed(checkpointMs)?checkpoint:null);
  const entry=(state,code,extra={})=>({...integrationEntry('resolver','source',state,code,success,null),lastBatchAt:batchSameGeneration&&batchAt&&!skewed(batchMs)?batchAt:null,...extra});
  if(continuation?.retryAt&&Date.parse(continuation.retryAt)>now)return integrationEntry('resolver','source','degraded','resolver_backoff',success,checkpoint);
  if(skewed(checkpointMs)||skewed(batchMs))return entry('unknown','no_data');
  if(continuation?.remainingChunks>0)return resolverProgress();
  const epgSettled=['complete','recovered'].includes(epgAttempt.outcome),exhausted=continuation?.remainingChunks===0;
  if(!sameGeneration||!epgSettled||!exhausted||!Number.isFinite(gateMs))return entry('waiting','resolver_waiting');
  if(gateMs>now)return entry('waiting','resolver_waiting',{gateAt:gate});
  const graceEnd=resolverProgressGraceEnd(gateMs);
  if(graceEnd==null||now<=graceEnd)return entry('waiting','resolver_waiting',{gateAt:gate});
  if(batchSameGeneration&&Number.isFinite(batchMs)&&batchMs>gateMs)return entry('waiting','resolver_waiting',{gateAt:gate});
  if(!Number.isFinite(checkpointMs)||!batchSameGeneration||!Number.isFinite(batchMs))return entry('unknown','no_data');
  if(q?.eligible!==true)return entry('waiting','resolver_waiting',{gateAt:gate});
  return entry('degraded','resolver_no_recent_progress',{gateAt:gate});
 };
 // AIR-598: the row maps the shared classification (src/discovery.js `discoveryQueueState`, the same one the Monitor, the Events report and the operational
 // status use) to its presentation. A queue proven empty reads «очередь пуста» with the time of its proof, whatever gate the drained continuation still carries;
 // the EPG-priority pause and a generation handoff are waits; an unconfirmed state is unknown, never empty and never a backlog.
 const resolverEntry=(state,code,success,failure,extra={})=>({...integrationEntry('resolver','source',state,code,success,failure),lastBatchAt:null,queueState:q?.state??null,queueReason:q?.reason??null,...extra});
 const resolver=(()=>{
  if(!q)return resolverEntry('unknown','no_data',null,null);
  if(q.state==='empty'){const at=integrationTime(q.provenAt)||integrationTime(q.lastChunkAt)||integrationTime(q.checkpointAt);return resolverEntry('healthy','queue_empty',at,null,{provenAt:at,proof:q.proof});}
  if(q.state==='running')return {...resolverProgress(),queueState:q.state,queueReason:q.reason};
  if(q.state==='paused')return resolverEntry('waiting','resolver_epg_priority',priorResolverSuccess,null);
  if(q.state==='failed')return resolverEntry('failed','resolver_failed',priorResolverSuccess,integrationTime(continuation?.at));
  if(q.state==='blocked')return q.reason==='missing_secret'?resolverEntry('degraded','resolver_unconfigured',priorResolverSuccess,null):resolverEntry('failed','resolver_failed',priorResolverSuccess,integrationTime(continuation?.at));
  if(q.state==='backlog'){
   if(q.reason==='backoff')return resolverEntry('degraded','resolver_backoff',priorResolverSuccess,integrationTime(continuation?.at));
   if(q.reason==='chunk_budget')return {...chunkBudgetRecognition(),queueState:q.state,queueReason:q.reason};
   return {...resolverProgress(),queueState:q.state,queueReason:q.reason};
  }
  if(['authority_loading','generation_mismatch','generation_handoff','gate_generation_moved'].includes(q.reason))return resolverEntry('waiting','resolver_handoff',priorResolverSuccess,null);
  return resolverEntry('unknown','resolver_unconfirmed',priorResolverSuccess,null);
 })();
 const predictions=predictionCapabilityHealth({run,live,now,recentRuns,queue,clock:predictionClock});
 const films=report?.watchlistCount||report?.films?.length||0,missing=(report?.stats?.metadataMissing||0)+(report?.stats?.titleMissing||0)+(report?.stats?.titleProvisional||0);
 const sources=[watchlist,ratingsSource,epg,resolver,...(producer===undefined?[]:[producerIntegration(producer)]),predictions];
 // `posters` is undefined only where the module is not bundled; a failed or timed-out read is null and shows as unknown, never healthy.
 if(posters!==undefined)sources.push(posterIntegration(posters));
 if(films>=10&&missing/films>=.2)sources.push(integrationEntry('metadata','source','degraded','metadata_attention',null,null));
 const failed=sources.filter(item=>item.state==='failed').length,attention=sources.filter(item=>!['healthy','off','running','waiting'].includes(item.state)).length;
 return {aggregate:failed?'failed':attention?'attention':'healthy',attentionCount:attention,failedCount:failed,sources};
}
// A source the footer reads. The footer is a dashboard of many sources and must stay readable when one of them is not: a read that fails or does not answer
// in time leaves that source `null` and is named in `degraded`, and everything that needs it becomes unknown (null, shown as «нет данных»), never 0. Without
// the guard one closed source (for example the Discovery ledger while its transfer is `loading`, which fails closed with `discovery_incomplete` by design)
// turned the whole route into the Worker's generic 502.
const FOOTER_SOURCE_TIMEOUT_MS=10000;
function footerGuard(env,degraded){
 const limit=Number(env?.FOOTER_SOURCE_TIMEOUT_MS)>0?Number(env.FOOTER_SOURCE_TIMEOUT_MS):FOOTER_SOURCE_TIMEOUT_MS;
 return async(name,load)=>{
  let timer=null;
  try{
   const pending=Promise.resolve().then(load);
   if(typeof setTimeout!=='function')return await pending;
   return await Promise.race([pending,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error('footer_source_timeout')),limit);
    // A host without clearTimeout (a test context that exposes only setTimeout) must not be kept alive by a timer nobody can clear.
    if(typeof clearTimeout!=='function'&&timer&&typeof timer.unref==='function')timer.unref();
   })]);
  }catch(error){
   if(['film_person_held','film_person_unavailable','film_person_generation_moved','canonical_read_unavailable','canonical_read_not_authoritative'].includes(error?.code))throw error;
   if(!degraded.includes(name))degraded.push(name);return null;
  }
  finally{if(timer!==null&&typeof clearTimeout==='function')clearTimeout(timer);}
 };
}
// The published programme and watchlist of a D1 generation, read with SELECTs only and fenced at the pinned generation. `loadJSON` reads the same documents
// without writing; R2 compatibility mirrors are reconciled by the EPG writer, not by a status GET.
async function footerPublishedDocument(pinned,key){
 if(pinned.epgPin?.authority==='d1'&&typeof PublishedEpg!=='undefined'){
  const run=pinned.epgPin.programmeRunId;
  if(!run)return null;
  return PublishedEpg.readDocumentAt(pinned,run,key==='watchlist.json'?'watchlist':'programme',pinned.epgPin.generation);
 }
 return loadJSON(pinned,key);
}
function canonicalCatalogReadRefusal(error){
 return ['film_person_held','film_person_unavailable','film_person_generation_moved','canonical_read_unavailable','canonical_read_not_authoritative'].includes(error?.code)
  ?json({error:'storage_unavailable',reason:error.code},503):null;
}
function canonicalIdentityIds(values){
 const ids=new Set();
 const add=id=>{if(id!=null&&id!=='')ids.add(String(id));};
 for(const value of values||[]){
  if(!value||typeof value!=='object')continue;
  if(Array.isArray(value.films)){for(const film of value.films)add(film?.id);continue;}
  for(const [key,item] of Object.entries(value)){
   add(key);
   if(item&&typeof item==='object'&&!Array.isArray(item))add(item.id);
  }
 }
 return [...ids];
}
// AIR-519. The footer reads the four large documents (view index, catalog, programme, watchlist) one after another and keeps of each only the fields its
// blocks read, so at most one of them is held whole at a time. Read together and kept whole they were about 60 MB of heap per request; overlapping
// requests of the same isolate then exceeded the Worker memory limit. A projection keeps every value it copies unchanged: the counts are the same.
const FOOTER_INDEX_FIELDS=['id','watched','actualRating','watchlist','prediction','fingerprintHash','impactFeatures'];
const FOOTER_FILM_FIELDS=['id','tmdbId','canonicalIdentity','catalogOnly','genres','epgLastAiring'];
function footerPick(value,fields){
 if(!value||typeof value!=='object'||Array.isArray(value))return value;
 const out={};
 for(const field of fields)if(Object.hasOwn(value,field))out[field]=value[field];
 return out;
}
// The view index: the facts and the prediction the collection, recommendation and coverage blocks read (fingerprint text, mood facets and the like are not).
function footerIndexProjection(index){
 if(!footerPlainObject(index))return index;
 const out={};
 for(const [id,item] of Object.entries(index))out[id]=footerPick(item,FOOTER_INDEX_FIELDS);
 return out;
}
// A catalog or programme film: identity, the genres the freshness rule reads and its showings. Under the completed-only rule (an authoritative D1 run)
// the coverage takes the showings of a catalog film from the programme, never from the record, so the record's own showings are not kept.
// A showing is read only by filmIsHot, which reads only its `start`, so a projected showing keeps `start` alone.
function footerShows(shows){return Array.isArray(shows)?shows.map(show=>show&&typeof show==='object'?{start:show.start}:show):shows;}
function footerFilmProjection(film,keepShows){
 const out=footerPick(film,FOOTER_FILM_FIELDS);
 if(out&&typeof out==='object'&&keepShows&&Object.hasOwn(film,'shows'))out.shows=footerShows(film.shows);
 return out;
}
function footerCatalogProjection(catalog,keepShows){
 if(!footerPlainObject(catalog))return catalog;
 const out={};
 for(const [id,film] of Object.entries(catalog))out[id]=footerFilmProjection(film,keepShows);
 return out;
}
// The programme: its counters and stats, member films with their showings and non-member showings (completedShowsByTmdb). Titles, people and posters are not read.
function footerProgrammeProjection(report){
 if(!footerPlainObject(report))return report;
 const out={...report};
 if(Array.isArray(report.films))out.films=report.films.map(film=>footerFilmProjection(film,true));
 if(Array.isArray(report.catalogFilms))out.catalogFilms=report.catalogFilms.map(film=>{const kept=footerPick(film,['id','tmdbId','shows']);if(kept&&typeof kept==='object'&&Object.hasOwn(kept,'shows'))kept.shows=footerShows(kept.shows);return kept;});
 return out;
}
function footerWatchlistProjection(watchlist){
 if(!footerPlainObject(watchlist)||!Array.isArray(watchlist.films))return watchlist;
 return {...watchlist,films:watchlist.films.map(film=>footerPick(film,['id','tmdbId']))};
}
// D1 metadata: the footer bridges a Letterboxd id to a TMDB id and honours a blocked identity (catalogLidTmdb); posters, titles and urls are not read.
function footerMetadataProjection(metadata){
 if(!footerPlainObject(metadata))return metadata;
 const out={};
 for(const [id,record] of Object.entries(metadata))out[id]=footerPick(record,['id','tmdbId','identityBlocked']);
 return out;
}
// The view index the footer reads: what loadJSON answers for it (the R2 object, then the D1 forecasts and the D1 ratings laid over it), reduced to
// FOOTER_INDEX_FIELDS. The R2 object is read member by member and each entry projected as it is parsed, so the whole object (11 MB of JSON, about
// three times that parsed) is never held; at the d1 authorities its forecast and rating facts are replaced anyway. The overlays are the same calls
// loadJSON makes, without the mood facet the footer does not read; projection commutes with them because they only set or drop the projected fields.
// When a d1 authority owns a fact, its overlay drops that fact from every R2 entry and lays the D1 value over it, so the R2 copy is not kept at all
// (prediction facts while predictions are d1; watched, rating and watchlist while ratings are ready). The authority is read again after the overlays:
// one that moved in between fails the read (the index is then unknown, never counted from a half-dropped copy).
async function footerViewIndex(env){
 // ADR 0183 / AIR-558: the index is always derived from D1 and the raw object is never read. The authority is checked again after the read.
 const derived=await derivedViewIndex(env,{moodFacet:null});
 const stillOpen=(await PredictionD1.readPredictionAuthority(env?.DB??null,env))?.mode==='d1'&&(await RatingsD1.readRatingsAuthority(env?.DB??null,env))?.ready===true;
 if(!stillOpen){const error=new Error('footer_index_authority_moved');error.code='footer_index_authority_moved';throw error;}
 return footerIndexProjection(Object.fromEntries(Object.entries(derived).map(([id,item])=>[id,footerPick(item,FOOTER_INDEX_FIELDS)])));
}
// A block computed from sources that were read: a malformed stored record (a queue without `pending`, a run without `selectedIds`) leaves that block
// unknown and names it in `degraded`; it does not turn the whole footer into a 502.
function footerCompute(degraded,name,compute,fallback){
 try{return compute();}
 catch{if(!degraded.includes(name))degraded.push(name);return fallback;}
}
async function footerStatus(env){
 const degraded=[],guard=footerGuard(env,degraded);
 const filmPersonGate=typeof CanonicalCatalogReader==='undefined'?null:await CanonicalCatalogReader.catalogReaderGate(env);
 const pinned=await guard('publication',()=>pinEpg(env))||env;
 const ratingsState=typeof LetterboxdRatings!=='undefined'?await guard('ratings',async()=>{const state=await LetterboxdRatings.storageState(env);return state.supported?{run:LetterboxdRatings.health(await LetterboxdRatings.readRun(env),Date.now())}:{blocked:{storage:'unsupported'}};}):null;
 const ratingsRun=ratingsState?.run??null,ratingsBlocked=ratingsState?.blocked??null;
 // AIR-344: the ledger is streamed and counted once, without keeping its items, before the other records are read.
 const authority=typeof DiscoveryAuthority!=='undefined'?await guard('discovery_authority',()=>DiscoveryAuthority.readAuthority(env)):null;
 const decisions=authority?.ready?{}:await guard('decisions',()=>loadJSON(env,'epg/discovery-resolution.json'));
 const ledger=await guard('ledger',()=>ledgerStatusAggregates(pinned,decisions||{},Date.now()));
 // The small records are read together; the four large documents are then read one at a time and projected as each arrives (AIR-519).
 const [profile,storedQueue,run,lease,sync,ratings,discoveryRead,watchlistIngest,metadataR2,predictionRuns]=await Promise.all([
  guard('profile',()=>loadJSON(env,profileKey)),
  guard('queue',()=>loadJSON(env,predictionQueueKey)),guard('run',()=>loadJSON(env,ENRICHMENT_KEY+'latest-run.json')),guard('lease',()=>loadJSON(env,RUNNER_LEASE_KEY)),guard('sync',()=>loadJSON(env,'sync.json')),guard('ratings_status',()=>loadJSON(env,RATINGS_STATUS_KEY)),
  // AIR-598: the Discovery records of one consistent snapshot through the shared reader, classified once (src/discovery.js `readDiscoveryQueue`).
  guard('discovery_queue',()=>readDiscoveryQueue(env)),guard('watchlist_ingest',()=>loadJSON(env,'watchlist-ingest.json')),
  // AIR-389 / AIR-499: metadata.json is frozen at open, so D1 replaces it after the large reads name the ids.
  filmPersonGate?.mode==='d1'?Promise.resolve(undefined):guard('metadata',async()=>footerMetadataProjection(await loadJSON(env,'metadata.json'))),
  guard('prediction_runs',async()=>(await diagnosticHistory(env,8)).runs)
 ]);
 const discoveryStatus=discoveryRead?.evidence?.records?.status??null,continuation=discoveryRead?.evidence?.records?.continuation??null,discoveryQueue=discoveryRead?.queue??null;
 const completedOnly=pinned?.epgPin?.authority==='d1';
 const index=await guard('index',()=>footerViewIndex(env));
 // A D1 catalog is projected film by film as its rows are parsed (DiscoveryAuthority `project`); an R2 catalog is projected once read.
 const catalog=await guard('catalog',async()=>footerCatalogProjection(await loadJSON(pinned,'epg/discovered-films.json',{project:film=>footerFilmProjection(film,!completedOnly)}),!completedOnly));
 const report=await guard('programme',async()=>footerProgrammeProjection(await footerPublishedDocument(pinned,'programme.json')));
 // AIR-389 / AIR-499: the watchlist is still one published object.
 const watchlist=await guard('watchlist',async()=>footerWatchlistProjection(await footerPublishedDocument(pinned,'watchlist.json')));
 let metadata=metadataR2;
 if(filmPersonGate?.mode==='d1')metadata=footerMetadataProjection(await CanonicalCatalogReader.catalogMetadataFromD1(env,canonicalIdentityIds([report,catalog,watchlist,index]),filmPersonGate,{identityOnly:true}));
 const freshness=await guard('freshness',()=>predictionFreshness(env,profile));
 // One read of monitor/state.json, shared by the poster markers and the Producer clock (AIR-593), one of the B1 checkpoint; no write, no TMDB.
 let monitorStateRead=null;
 const readMonitorState=()=>monitorStateRead||(monitorStateRead=loadJSON(env,'monitor/state.json'));
 const posters=typeof CatalogPosterWeekly==='undefined'?undefined:await guard('posters',async()=>{const state=await readMonitorState();return CatalogPosterWeekly.readStatus(env,{markers:{baselineAt:state?.catalogPostersBaselineAt??null,seenAt:state?.catalogPostersSeenAt??null},monitorOn:env?.MONITOR==='on',nowMs:Date.now()});});
 // AIR-593: the canonical Producer, three indexed D1 statements through the Monitor's own reader; a failed read is unknown, never healthy.
 const producerBundled=typeof CanonicalProducerWorkflow!=='undefined'&&typeof Monitor!=='undefined'&&typeof MonitorPolicy!=='undefined'&&!!env?.DB;
 const producer=producerBundled?await guard('canonical_producer',()=>footerProducerView(env,readMonitorState,Date.now())):undefined;
 // AIR-596: the Monitor's stored prediction progress clock (same document, no extra read). Unreadable is simply absent: the history and the queue still decide.
 const predictionClock=await Promise.resolve().then(readMonitorState).then(doc=>doc?.predictions&&typeof doc.predictions==='object'?doc.predictions:null,()=>null);
 if(filmPersonGate)await CanonicalCatalogReader.catalogReaderStill(env,filmPersonGate);
 // Coverage needs the programme, the catalog, the view index and the freshness rule. If any of them could not be read the numbers are unknown, not zero or 100%.
 // A programme or catalog object that is simply absent (the read answered null) is as unreadable as one that failed: it is not an empty collection with 100% coverage.
 if(!footerPlainObject(report)&&!degraded.includes('programme'))degraded.push('programme_missing');
 if(!footerPlainObject(catalog)&&!degraded.includes('catalog'))degraded.push('catalog_missing');
 // An absent view index or taste profile is not a measured 0 current predictions either: without them the coverage is unknown.
 if(!footerPlainObject(index)&&!degraded.includes('index'))degraded.push('index_missing');
 if(!footerPlainObject(profile)&&!degraded.includes('profile'))degraded.push('profile_missing');
 const coverageReadable=!['programme','catalog','index','profile','freshness','programme_missing','catalog_missing','index_missing','profile_missing'].some(name=>degraded.includes(name))&&!!freshness;
 const unknownCoverage={confirmedFilmsTotal:null,currentPredictionsTotal:null,windowFilmsTotal:null,windowCurrentPredictions:null,cacheOffWindowTotal:null,pendingOffWindowTotal:null};
 const coverage=coverageReadable?footerCompute(degraded,'coverage',()=>canonicalCoverageSummary(report,catalog,index,profile,Date.now(),freshness,completedOnly),null)||unknownCoverage:unknownCoverage;
 const coverageKnown=coverage!==unknownCoverage;
 const queue=footerCompute(degraded,'queue_view',()=>queueStatusView(storedQueue),null),slices=footerCompute(degraded,'queue_view',()=>predictionQueueSlices(storedQueue),predictionQueueSlices(null));
 const collection=footerCompute(degraded,'collection',()=>footerCollection({report,catalog,watchlist,index,metadata}),{state:'unknown',total:null,watched:null,rated:null,watchlist:null});
 const newUnseen=footerCompute(degraded,'recommendations',()=>footerNewUnseen({report,catalog,watchlist,index,metadata,profile,freshness}),{state:'unknown',rating40to44:null,rating45plus:null});
 const recognized=ledger?.recognized??null,counts=ledger?.counts??null;
 const pendingRecognition=counts?counts.currentUnresolved:null,historicalUnresolved=counts?counts.historicalUnresolved+counts.expiredInactive:null;
 const difference=(total,current)=>Number.isInteger(total)&&Number.isInteger(current)?total-current:null;
 const live=run?.status==='running'&&lease?.runId===run.runId&&lease.expiresAt>Date.now(),summary=run?footerCompute(degraded,'run',()=>runSummary(run),null):null;
 const runStatus=!run?'idle':live?'running':run.status==='running'?'blocked':run.status==='partial'?'blocked':run.status==='complete'?'completed':run.status||'idle';
 const rawReason=run?.stopReason||run?.reason,reason=['queue_empty','eligible_queue_empty','retry_backoff'].includes(rawReason)?rawReason:safePredictionReason(rawReason);
 return {schemaVersion:1,generatedAt:new Date().toISOString(),profile:profile?{version:profile.version,updatedAt:profile.updatedAt}:null,collection,recommendations:{newUnseen},coverage:coverageKnown?{...coverage,localPercent:coveragePercent(coverage.currentPredictionsTotal,coverage.confirmedFilmsTotal),windowPercent:coveragePercent(coverage.windowCurrentPredictions,coverage.windowFilmsTotal),windowPendingTotal:coverage.windowFilmsTotal-coverage.windowCurrentPredictions}:{...coverage,localPercent:null,windowPercent:null,windowPendingTotal:null},predictions:{pendingHot:queue?.hotRemaining??difference(coverage.windowFilmsTotal,coverage.windowCurrentPredictions),pendingCold:queue?.coldRemaining??coverage.pendingOffWindowTotal,outstanding:slices.outstanding,eligibleNow:slices.eligibleNow,deferredByRetry:slices.deferredByRetry,retryExhausted:slices.retryExhausted,nextRetryAt:slices.nextRetryAt,pendingOffWindow:coverage.pendingOffWindowTotal,currentBatch:live?{size:run.batchSize??run.selectedIds?.length??null}:null,nextBatchSize:queue?.adaptiveBatch?.batchSize??0,nextScheduledRun:null},epgTmdb:{recognizedFilms:recognized?recognized.size:null,pendingRecognition,historicalUnresolved,ledgerTotal:counts?counts.ledgerTotal:null,confirmedMovies:coverage.confirmedFilmsTotal,cacheOffWindow:coverage.cacheOffWindowTotal,epgStart:report?.stats?.epgStart??null,epgEnd:report?.stats?.epgEnd??null,channels:report?.stats?.channels??null,checkedTransmissions:report?.stats?.scanned??null},watchlist:{films:report?(report.watchlistCount??report.films?.length??0):null,updatedAt:report?.watchlistUpdatedAt||report?.updatedAt||null,titleMissing:report?.stats?.titleMissing??0,titleProvisional:report?.stats?.titleProvisional??0,metadataMissing:report?.stats?.metadataMissing??0},lastRun:run?{status:runStatus,reason,startedAt:run.createdAt||null,finishedAt:run.completedAt||null,added:summary?summary.added:null,failed:summary?summary.failed:null}:null,integrations:footerCompute(degraded,'integrations',()=>integrationHealth({posters,producer,sync,ratings,enabled:false,report,continuation,discoveryStatus,discoveryQueue,run,live,now:Date.now(),watchlistIngest,ratingsRun,ratingsBlocked,recentRuns:predictionRuns,queue:storedQueue,predictionClock}),{aggregate:'unknown',attentionCount:null,failedCount:null,sources:[]}),...(degraded.length?{degraded:[...degraded]}:{})};
}
function queueLaneIds(queue,exclude=new Set()){
 const skip=id=>exclude.has(id)||retryBudgetExhausted(queue.retries?.[id]);
 const hot=(queue.hotPending||[]).filter(id=>!skip(id));
 if(hot.length)return hot;
 return (queue.coldPending||queue.pending||[]).filter(id=>!skip(id));
}
function queueReadyIds(queue,now=Date.now(),exclude=new Set()){return queueLaneIds(queue,exclude).filter(id=>!(queue.retries?.[id]?.retryAt>now));}
// The ids a batch takes, in queue order: migration work (ADR-0035 section 6) fills at most FINGERPRINT_MIGRATION_SHARE of the
// slots, rounded up; the other slots go to missing work. Slots migration cannot fill stay empty rather than widening the share.
function queueBatchIds(queue,ready,slots){
 const cap=Math.ceil(slots*FINGERPRINT_MIGRATION_SHARE),taken=[];let migration=0;
 for(const id of ready){if(taken.length>=slots)break;if(queue.work?.[id]?.migration){if(migration>=cap)continue;migration++;}taken.push(id);}
 return taken;
}
// Recovery slots (ADR 0197). A batch of N films reserves at most RECOVERY_BATCH_SHARE of its slots for owner-confirmed recovery intents (ADR 0165), independent of hot/cold:
// N>=2 gives max(1,floor(N*0.4)) target slots, N=1 keeps the ordinary policy. It is a ceiling on the privileged slots, not a throughput promise; slots the recovery queue cannot fill go back to the ordinary queue.
const RECOVERY_BATCH_SHARE=0.4;
function recoveryBatchSlots(size){
 if(!Number.isInteger(size)||size<2)return 0;
 return Math.min(size,Math.max(1,Math.floor(Math.round(size*RECOVERY_BATCH_SHARE*1e6)/1e6)));
}
// The films that may take a recovery slot now, in order, plus the counts a read-only diagnostic shows. A candidate has an active, unexpired intent (the overlay read of this very selection),
// and it is ready: queued in either lane, not retry-exhausted, not in retry backoff, not excluded. The queue's `work` map is not consulted (it is kept only for hot and watchlist films); whether the intent is still
// unresolved is decided when the film is read: its stored current prediction must still be the exact version the intent denies.
// Order: the owner's confirmation time of its cohort (oldest first), then the film's position in the stored queue (hot lane, then cold lane), then the film id. Nothing here changes the stored queue.
function queueRecoveryCandidates(queue,overlay,now=Date.now(),exclude=new Set()){
 const counts={active:0,eligible:{hot:0,cold:0},deferredByRetry:0,retryExhausted:0,notQueued:0},position=new Map(),ids=[];
 [...(queue.hotPending||[]),...(queue.coldPending||queue.pending||[])].forEach((id,index)=>{if(!position.has(id))position.set(id,index);});
 for(const id of overlay?.activeIds?.()||[]){
  if(exclude.has(id))continue;
  counts.active++;
  if(retryBudgetExhausted(queue.retries?.[id])){counts.retryExhausted++;continue;}
  if(!position.has(id)){counts.notQueued++;continue;}
  if(queue.retries?.[id]?.retryAt>now){counts.deferredByRetry++;continue;}
  counts.eligible[queue.priority?.[id]?.hot?'hot':'cold']++;ids.push(id);
 }
 const confirmed=id=>overlay.confirmedAtOf?.(id)??null;
 ids.sort((a,b)=>{const x=confirmed(a),y=confirmed(b);return (x===y?0:x===null?1:y===null?-1:x<y?-1:1)||position.get(a)-position.get(b)||(a<b?-1:a>b?1:0);});
 return {ids,counts};
}
const RUN_DIAGNOSTICS_PREFIX=ENRICHMENT_KEY+'run-diagnostics/';
const RUN_DIAGNOSTICS_SETTLE_KEY=ENRICHMENT_KEY+'run-diagnostics-settle.json';
const RUN_DIAGNOSTICS_SETTLE_LIMIT=10;
function diagnosticKey(id,at){return RUN_DIAGNOSTICS_PREFIX+String(9999999999999-Date.parse(at)).padStart(13,'0')+'-'+id+'.json';}
async function diagnosticCheckpoint(env,run,patch={}){
 if(run.runId.startsWith('blocked-'))return null; // Aggregate stop Events are not additional trigger attempts.
 const at=run.diagnosticStartedAt||run.createdAt,key=diagnosticKey(run.runId,at),old=await loadJSON(env,key),queue=await loadJSON(env,predictionQueueKey),lease=await loadJSON(env,RUNNER_LEASE_KEY),summary=runSummary(run);
 const value={runId:run.runId,trigger:run.trigger==='scheduled'?'scheduled':'manual',startedAt:at,endedAt:run.completedAt||null,state:run.status==='complete'?'completed':run.status==='partial'?'blocked':run.status||'running',startResult:old?.startResult||run.startResult||'running',stopReason:run.stopReason||run.reason||null,leaseAcquiredAt:old?.leaseAcquiredAt||run.leaseAcquiredAt||null,leaseExpiredAt:lease?.runId===run.runId?new Date(lease.expiresAt||Date.parse(old?.leaseExpiredAt||at)).toISOString():old?.leaseExpiredAt||null,lastHeartbeatAt:run.lastHeartbeatAt||old?.lastHeartbeatAt||null,firstNextAt:run.firstNextAt||old?.firstNextAt||null,firstSubmitAt:run.firstSubmitAt||old?.firstSubmitAt||null,added:summary.added,updated:summary.updated,failed:summary.failed,hotRemaining:queue?.priorityCount??run.hotRemaining??null,coldRemaining:queue?.coldRemaining??run.coldRemaining??null,batchesProcessed:Math.max(0,(run.batchCount||1)-1)+(run.selectedIds?.length&&run.selectedIds.every(id=>run.results?.[id])?1:0),...patch,steps:Array.isArray(old?.steps)?old.steps.slice(-8):[],lastAttemptedStep:old?.lastAttemptedStep||null,lastCompletedStep:old?.lastCompletedStep||null,serverFault:old?.serverFault||null,callerFault:run.callerFault||old?.callerFault||null,itemValidation:run.itemValidation||old?.itemValidation||null,delivery:'unconfirmed'};
 await saveJSON(env,key,value);return value;
}
function leaseExpiredDiagnostic(row,now=Date.now()){
 return !!(row&&row.state==='running'&&row.leaseExpiredAt&&Date.parse(row.leaseExpiredAt)<=now);
}
function projectedDiagnostic(row,now=Date.now()){
 if(!leaseExpiredDiagnostic(row,now))return row;
 return {...row,state:'interrupted',stopReason:row.leaseAcquiredAt?'lease_expired':'runner_aborted',endedAt:row.endedAt||row.leaseExpiredAt};
}
async function persistExpiredDiagnostic(env,itemKey,row,now=Date.now()){
 if(!leaseExpiredDiagnostic(row,now))return;
 // The diagnostic row's leaseExpiredAt is not authority while this run still holds the live runner lease
 // (heartbeat renews the lease before savePredictionRun / diagnosticCheckpoint). A stale timestamp must not
 // interrupt the live holder from another run's prediction_complete sweep.
 const lease=await loadJSON(env,RUNNER_LEASE_KEY);
 if(lease?.runId===row.runId&&lease.expiresAt>now)return;
 const run=await checkedRun(env,row.runId);
 if(run&&['running','interrupted'].includes(run.status)){
  if(run.status==='interrupted'&&run.stopReason==='lease_expired'&&row.state==='interrupted')return;
  run.status='interrupted';run.recoverable=true;run.stopReason='lease_expired';run.reason='lease_expired';run.completedAt=run.completedAt||row.leaseExpiredAt;
  await saveJSON(env,runKey(run.runId),run);await diagnosticCheckpoint(env,run);return;
 }
 await saveJSON(env,itemKey,projectedDiagnostic(row,now));
}
async function settleExpiredDiagnostics(env,now=Date.now()){
 // One small R2 list page per authorized complete (AIR-486), with a durable resume cursor. A list/get/put error
 // leaves the cursor unchanged so the next complete retries the same page; already-settled rows are no-ops. The
 // start path recovers only the lease holder's recoveredRunId and does not walk this prefix (AIR-415 settlement
 // stays eventual, not on the batch_start HTTP critical path).
 try{
  const state=await loadJSON(env,RUN_DIAGNOSTICS_SETTLE_KEY)||{};
  const page=await env.BUCKET.list({prefix:RUN_DIAGNOSTICS_PREFIX,limit:RUN_DIAGNOSTICS_SETTLE_LIMIT,...(state.cursor?{cursor:state.cursor}:{})});
  for(const item of page.objects||[]){const row=await loadJSON(env,item.key);if(row)await persistExpiredDiagnostic(env,item.key,row,now);}
  const next=page.truncated?page.cursor||null:null;
  if(next===null&&!state.cursor)return;
  await saveJSON(env,RUN_DIAGNOSTICS_SETTLE_KEY,{cursor:next,at:new Date(now).toISOString()});
 }catch{}
}
async function diagnosticHistory(env,limit=10){
 const page=await env.BUCKET.list({prefix:RUN_DIAGNOSTICS_PREFIX,limit}),rows=[];
 for(const item of page.objects||[]){const row=await loadJSON(env,item.key);if(row)rows.push(projectedDiagnostic(row));}
 return {runs:rows.sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt)||b.runId.localeCompare(a.runId)).slice(0,limit).map(presentDiagnostic)};
}
// AIR-417 / AIR-424. While an EPG publication holds or loads the Discovery authority, the catalog cannot be read and the queue cannot be rebuilt.
// That is a wait, not a storage failure: start answers 503 blocked `prediction_catalog_held`, keeps no lease and writes no stop Event.
// next, submit and complete of an owned run answer the same 503, keep the lease and do not stop. `cause` is the Discovery code that refused the read.
const CATALOG_HELD_CODES=['discovery_fence','discovery_incomplete'];
const catalogHeldResponse=(cause,extra={})=>json({status:'blocked',reason:'catalog_held',code:'prediction_catalog_held',cause,...extra,...scheduledRunFields()},503);
// AIR-574: the gate names the three Discovery states apart. (`gate.held` is defensive: `readAuthority` refuses a real held cutover itself with `discovery_unavailable`, ADR 0162.) A held cutover and a loading transfer that is a catalog replacement (a pending admission, or no ledger handoff) still hold the catalog.
// A `loading` ledger seal (an EPG publication moving the ledger, ADR 0091) does not: the admission lookups and the catalog read both stay open under it (`readAdmissionsById`, `SEAL_SAFE_KEYS`),
// so a start whose selection was already read from a consistent queue must not be refused by it. Every read keeps its own fence, and the lease-time preflight repeats them.
async function catalogHeldCause(env){
 if(typeof DiscoveryAuthority==='undefined')return null;
 const gate=await DiscoveryAuthority.readAuthority(env);
 if(gate.held)return 'discovery_fence';
 if(!gate.ready||gate.transfer!=='loading')return null;
 return await DiscoveryAuthority.loadingIsLedgerSeal(env)?null:'discovery_incomplete';
}
function catalogHeldQueueError(error){return CATALOG_HELD_CODES.includes(error?.code)&&error.stage==='queue_refresh'?error:null;}
function ownedCatalogHeld(boundary,error,requestId,runId,extra={}){
 logPredictionFailure(boundary,error,requestId,runId);
 return catalogHeldResponse(error.code,{runId,leaseTtlMs:RUNNER_LEASE_TTL,...extra});
}
// The start finds nothing eligible: it releases the lease and records the idle check (a quota or retry-backoff stop is blocked, an empty queue is a noop).
async function startIdle(env,{body,profile,queue,plan}){
 const at=new Date().toISOString(),remaining=queue.priorityCount+queue.coldRemaining,reason=plan.reason==='quota'?'quota':remaining?'retry_backoff':null,stage=reason?'blocked':'noop';const lastBatch={runId:null,trigger:body.trigger==='scheduled'?'scheduled':'manual',startedAt:at,finishedAt:at,stage,profileVersion:profile.version,batchSize:0,hotProcessed:0,coldProcessed:0,hotRemaining:queue.priorityCount,coldRemaining:queue.coldRemaining,checked:0,added:0,updated:0,failed:0,remaining,reason};await mutatePredictionQueue(env,current=>({...current,lastCheckAt:at,lastBatch}),'start_check');return json({status:stage,...lastBatch,...scheduledRunFields()});
}
// ---- Batch runner v2: batch_start (ADR 0122 + ADR 0136). One request returns one self-sufficient manifest of at most the client-requested manifestSize (default and ceiling BATCH_RUNNER.maxManifestFilms). ----
// It shares the queue, runner lease, retry records and persistence of the retired v5 runner (ADR 0167), whose stored runs it still recognizes. `batch_submit` is a separate delivery.
const BATCH_PROTOCOL='batch_v2';
const BATCH_V2_PRESENTATION='batch_v2_terminal';
const BATCH_MANIFEST_FORMAT='compact-1';
function isBatchV2Run(run){return run?.protocol===BATCH_PROTOCOL;}
function batchV2EventFields(run){return isBatchV2Run(run)?{protocol:BATCH_PROTOCOL,presentation:BATCH_V2_PRESENTATION}:{};}
// Compact named-film rows for the one terminal Event. Snapshotted on the run at submit of this version, never rebuilt from a later latest prediction.
function eventFilmIdentity(meta,filmId){
 const title=typeof meta?.title==='string'&&meta.title.trim()?meta.title.trim().slice(0,200):(typeof meta?.original==='string'&&meta.original.trim()?meta.original.trim().slice(0,200):null);
 const year=Number.isInteger(meta?.year)?meta.year:null,out={filmId:String(filmId)};
 if(title)out.title=title;if(year!==null)out.year=year;return out;
}
function halfStarRating(value){return typeof value==='number'&&Number.isFinite(value)&&value>=.5&&value<=5&&value*2%1===0?value:null;}
function compactEventSource(assessment){
 const listed=Array.isArray(assessment?.sources)?assessment.sources:(Array.isArray(assessment?.callerReported?.sources)?assessment.callerReported.sources:[]);
 const sources=listed.filter(s=>s&&typeof s==='object'),kinds=[],seen=new Set(),accesses=[],authors=[],authorSeen=new Set();
 for(const s of sources){
  if(!['metadata','model_knowledge','web_research'].includes(s.kind))continue;
  if(!seen.has(s.kind)){seen.add(s.kind);kinds.push(s.kind);}
  if(s.kind==='web_research'&&['full_text','partial_text','search_snippet'].includes(s.access)&&!accesses.includes(s.access))accesses.push(s.access);
 }
 const conflicts=Array.isArray(assessment?.conflicts)?assessment.conflicts:(Array.isArray(assessment?.callerReported?.conflicts)?assessment.callerReported.conflicts:[]);
 for(const c of conflicts){
  for(const pos of Array.isArray(c?.positions)?c.positions:[]){
   const src=Number.isInteger(pos?.source)?sources[pos.source]:null;
   if(!src||src.kind!=='web_research'||!['full_text','partial_text'].includes(src.access))continue;
   const name=typeof pos.author==='string'?pos.author.trim().slice(0,80):'';
   if(!name)continue;
   const key=name.toLowerCase();if(authorSeen.has(key))continue;authorSeen.add(key);authors.push(name);
   if(authors.length>=3)break;
  }
  if(authors.length>=3)break;
 }
 const out={};if(kinds.length)out.kinds=kinds;if(accesses.length)out.accesses=accesses;if(authors.length)out.authors=authors;return out;
}
function rememberBatchEventFilm(run,id,source,extra){
 if(!isBatchV2Run(run))return;
 run.eventFilms||={success:{},failure:{}};
 const identity=eventFilmIdentity(source?.[id],id);
 if(extra.group==='success'){
  const existing=run.eventFilms.success[id],hasBody=existing&&(existing.rating!=null||(existing.source&&(existing.source.kinds||existing.source.authors)));
  if(hasBody)return;
  const rating=halfStarRating(extra.rating),row={...identity,status:extra.status,source:extra.source&&typeof extra.source==='object'?extra.source:{}};
  if(rating!==null)row.rating=rating;run.eventFilms.success[id]=row;
 }else if(extra.group==='failure'){
  const row={...identity,kind:typeof extra.kind==='string'?extra.kind:null};
  if(Number.isInteger(extra.attempts)&&extra.attempts>=1)row.attempts=extra.attempts;
  run.eventFilms.failure[id]=row;
 }
}
function applyRetrySnapshot(run,queue){
 if(!isBatchV2Run(run))return;
 for(const [id,failure] of Object.entries(run.failures||{})){
  const queued=queue?.retries?.[id];if(!queued)continue;
  const attempts=Math.max(Number.isInteger(failure.attempts)?failure.attempts:0,Number.isInteger(queued.attempts)?queued.attempts:0);
  if(attempts>=1)failure.attempts=attempts;
  if(Number.isFinite(queued.retryAt))failure.retryAt=Math.max(failure.retryAt||0,queued.retryAt);
 }
}
async function recoverBatchEventFilms(env,run,source,states){
 if(!isBatchV2Run(run))return;
 for(let i=0;i<(run.selectedIds||[]).length;i++){
  const id=run.selectedIds[i],status=run.results?.[id];
  if(status!=='created'&&status!=='recalculated')continue;
  const existing=run.eventFilms?.success?.[id];
  if(existing&&existing.rating!=null&&existing.source&&(existing.source.kinds||existing.source.authors))continue;
  const p=states[i]?.predictions?.current;if(!p||p.runId!==run.runId)continue;
  let assessment=null;
  if(typeof p.contentSha256==='string')try{assessment=await loadJSON(env,predictionAssessmentKey(id,p.contentSha256));}catch{assessment=null;}
  if(assessment?.confirmed?.runId&&assessment.confirmed.runId!==run.runId)assessment=null;
  rememberBatchEventFilm(run,id,source,{group:'success',status,rating:p.predictedRating,source:compactEventSource(assessment)});
 }
}
function batchProcessedCount(run){
 const ids=new Set();
 for(const [id,status] of Object.entries(run.results||{}))if(['created','recalculated','already_current','failed'].includes(status))ids.add(id);
 for(const id of Object.keys(run.failures||{}))ids.add(id);
 return ids.size;
}
function batchV2EventDetails(run,source){
 const success=[],failure=[],ids=Array.isArray(run.selectedIds)?run.selectedIds:[];
 for(const id of ids){
  const outcome=run.results?.[id];
  if(outcome==='created'||outcome==='recalculated'){
   const snap=run.eventFilms?.success?.[id];
   success.push(snap&&snap.filmId?snap:{...eventFilmIdentity(source?.[id],id),status:outcome,source:{}});
  }else if(outcome==='failed'||run.failures?.[id]){
   const rec=run.failures[id]||{},snap=run.eventFilms?.failure?.[id]||eventFilmIdentity(source?.[id],id);
   const attempts=Number.isInteger(rec.attempts)?rec.attempts:(Number.isInteger(snap.attempts)?snap.attempts:undefined);
   const row={filmId:snap.filmId||String(id),kind:typeof rec.kind==='string'?rec.kind:(typeof snap.kind==='string'?snap.kind:null)};
   if(snap.title)row.title=snap.title;if(Number.isInteger(snap.year))row.year=snap.year;
   if(Number.isInteger(attempts)&&attempts>=1)row.attempts=attempts;
   if(retryBudgetExhausted({...rec,...(attempts!==undefined?{attempts}:{})}))row.exhausted=true;
   const claimed=rec.validation?.claimed?.reason;if(typeof claimed==='string'&&CALLER_FAILURE_REASONS.includes(claimed))row.claimed=claimed;
   failure.push(row);
  }
 }
 return {processed:batchProcessedCount(run),success,failure};
}
function withBatchV2EventDetails(event,run,source){
 if(!isBatchV2Run(run)||!event)return event;
 return {...event,details:batchV2EventDetails(run,source||{})};
}
const BATCH_RUNNER={version:2,maxManifestFilms:100,maxManifestBytes:256*1024,generationSizeDefault:10,generationSizeRange:[1,10],submitMaxItems:10,submitMaxBodyBytes:56*1024,callBudgetMs:25000};
const BATCH_STAGE_KEY=ENRICHMENT_KEY+'batch-stage.json';
// Films read to fill one manifest when some queued films are already current or have lost their admission: bounded so a start never walks the whole queue.
const BATCH_SCAN_LIMIT=300;
// Recovery probing has its own bound inside the shared one: films that never become manifest items (a moved pointer, a vanished admission) cannot use the budget the ordinary fill needs.
const RECOVERY_SCAN_LIMIT=100;
const BATCH_PLACEHOLDER_RUN='00000000-0000-4000-8000-000000000000';
const wrongProtocolResponse=()=>json({error:'This run belongs to another protocol',code:'wrong_protocol'},409);
const batchBlocked=(code,extra={})=>json({status:'blocked',reason:code,code,...extra,...scheduledRunFields()},409);
const batchLimits=()=>({maxManifestFilms:BATCH_RUNNER.maxManifestFilms,maxManifestBytes:BATCH_RUNNER.maxManifestBytes,generationSizeDefault:BATCH_RUNNER.generationSizeDefault,generationSizeRange:BATCH_RUNNER.generationSizeRange,submitMaxItems:BATCH_RUNNER.submitMaxItems,submitMaxBodyBytes:BATCH_RUNNER.submitMaxBodyBytes,callBudgetMs:BATCH_RUNNER.callBudgetMs});
// Lossless: an absent key reads as null. Nothing else of a film's metadata or stored fingerprint is shortened.
const batchCompact=value=>Array.isArray(value)?value.map(batchCompact):isObject(value)?Object.fromEntries(Object.entries(value).filter(([,v])=>v!==null&&v!==undefined).map(([k,v])=>[k,batchCompact(v)])):value;
// Client-requested selection cap (ADR 0136). Omitted → server ceiling 100. Not an integer in 1..maxManifestFilms → 400, no writes. generationSize / submitBatchSize stay client/prompt parameters and are never derived from this.
function resolveManifestSize(body){
 if(!isObject(body)||body.manifestSize===undefined)return {size:BATCH_RUNNER.maxManifestFilms};
 if(!Number.isInteger(body.manifestSize)||body.manifestSize<1||body.manifestSize>BATCH_RUNNER.maxManifestFilms)return {error:json({error:'Invalid manifestSize'},400)};
 return {size:body.manifestSize};
}
function validateBatchStartBody(body){
 if(!isObject(body)||body.scope!=='watchlist_all'||(body.mode!==undefined&&body.mode!=='queued'))return json({error:'Invalid scope or mode'},400);
 if(body.trigger!==undefined&&body.trigger!=='scheduled'&&body.trigger!=='manual')return json({error:'Invalid trigger'},400);
 if(body.capacity!==undefined&&(!isObject(body.capacity)||body.capacity.remainingPercent!==undefined&&(!Number.isFinite(body.capacity.remainingPercent)||body.capacity.remainingPercent<0||body.capacity.remainingPercent>100)))return json({error:'Invalid capacity'},400);
 if(body.dryRun!==undefined&&typeof body.dryRun!=='boolean')return json({error:'Invalid dryRun'},400);
 if(body.invocationKey!==undefined&&(typeof body.invocationKey!=='string'||!INVOCATION_KEY_PATTERN.test(body.invocationKey)))return json({error:'Invalid invocationKey'},400);
 if(body.deferred!==undefined&&typeof body.deferred!=='boolean')return json({error:'Invalid deferred'},400);
 // AIR-588 (C, ADR 0205): the shape of a real start's answer. `full` (the default, every caller before this) is the whole manifest; `envelope` is the compact ready envelope of the SAME stored
 // manifest, whose parts the caller reads with prediction_batch_manifest. A dry run stores nothing to read back and a deferred start answers a receipt, so neither takes it.
 if(body.answer!==undefined&&body.answer!=='full'&&body.answer!=='envelope')return json({error:'Invalid answer',code:'invalid_answer'},400);
 if(body.answer==='envelope'&&(body.dryRun===true||body.deferred===true))return json({error:'answer envelope needs a real, synchronous start whose manifest is stored',code:'envelope_needs_stored_manifest'},400);
 if(body.taskId!==undefined){
  // ADR 0195: a Task label belongs to a scheduled start only, never to a manual one. With the keyed protocols of ADR 0188 / 0193 it is only a correlation (the key still decides the join).
  if(!isTaskId(body.taskId))return json({error:'Invalid taskId',code:'invalid_task_id'},400);
  if(body.trigger!=='scheduled')return json({error:'taskId is accepted only with trigger scheduled',code:'task_id_requires_scheduled'},400);
 }
 if(body.deferred===true){
  // A deferred start needs the key the server issued; it is never a dry run and never a pin.
  if(typeof body.invocationKey!=='string'||!DEFERRED_KEY_PATTERN.test(body.invocationKey))return json({error:'A deferred start needs the invocationKey issued by prediction_batch_key',code:'invalid_deferred_key'},400);
  if(body.dryRun===true||body.pin!==undefined)return json({error:'deferred is not accepted with dryRun or pin',code:'deferred_not_dry_run'},400);
 }
 const size=resolveManifestSize(body);if(size.error)return size.error;
 if(body.pin!==undefined){
  if(body.dryRun!==true)return json({error:'pin is accepted only with dryRun'},400);
  // pin.filmIds must not silently truncate to manifestSize: more pinned ids than the requested (or default) size is an invalid request.
  if(!isObject(body.pin)||!Array.isArray(body.pin.filmIds)||!body.pin.filmIds.length||body.pin.filmIds.length>size.size||body.pin.filmIds.some(id=>!isText(id,100)))return json({error:'Invalid pin'},400);
 }
 return null;
}
// The prediction authority marker must be d1: the per-film commit of batch_submit is one guarded D1 batch (ADR 0122), so v2 does not run on the object mode.
async function batchRequiresD1(env){
 const authority=typeof PredictionD1==='undefined'?null:await PredictionD1.readPredictionAuthority(env?.DB,env);
 return authority?.mode==='d1'?null:batchBlocked('batch_runner_requires_d1');
}
// Films for one manifest, read-only: the stored queue's ready ids in queue order, each with its admission and stored state. A film whose admission is gone or whose
// prediction is already current is not delivered (no stored usable work is regenerated); it is reported so that the real start can settle it out of the queue.
async function batchSelection(env,{profile,report,queue,pin=null,limit=BATCH_RUNNER.maxManifestFilms,excludeIds=null}){
 const cap=Math.min(Math.max(1,Number.isInteger(limit)?limit:BATCH_RUNNER.maxManifestFilms),BATCH_RUNNER.maxManifestFilms);
 const freshness=await predictionFreshness(env,profile),items=[],skipped={missingAdmission:[],alreadyCurrent:[]},notEligible=[];
 const exclude=excludeIds instanceof Set?excludeIds:new Set(Array.isArray(excludeIds)?excludeIds:[]);
 const queued=new Set([...(queue.pending||[]),...(queue.hotPending||[]),...(queue.coldPending||[])]),ready=queueReadyIds(queue,Date.now(),exclude),readySet=new Set(ready);
 let rest;
  if(pin){rest=[];for(const id of [...new Set(pin.filmIds.map(String))]){if(exclude.has(id))continue;if(retryBudgetExhausted(queue.retries?.[id]))notEligible.push({filmId:id,reason:'retry_exhausted'});else if(!queued.has(id))notEligible.push({filmId:id,reason:'not_queued'});else if(!readySet.has(id))notEligible.push({filmId:id,reason:'retry_backoff'});else rest.push(id);}}
 else rest=ready.slice();
 let scanned=0;
 const overlay=freshness.overlay;
 // One chunk of film ids: read their payloads and stored states, and keep each film that still needs work. Returns how many films it added to the manifest.
 // `recoverySlot` films must still carry the exact version their intent denies; a film whose stored version moved on (satisfied) or that has none is not recovery work: it is returned in `deferred`
 // and left to the ordinary queue.
 const take=async(chunk,recoverySlot)=>{
  const found=await readFilmsById(env,report,chunk),states=await Promise.all(chunk.map(id=>found.has(id)?readFilmStateCurrent(env,id):null));
  let added=0;const deferred=[];
  chunk.forEach((id,i)=>{
   const film=found.get(id);if(!film){skipped.missingAdmission.push(id);return;}
   const state=states[i];if(freshness.state(state.predictions?.current,state.fingerprint,film.genres,id)){skipped.alreadyCurrent.push(id);return;}
   if(recoverySlot&&!(state.predictions?.current&&overlay.deniesPrediction(id,state.predictions.current))){deferred.push(id);return;}
   const plan=freshness.fingerprintUsable(state.fingerprint,film.genres,id)?'prediction_only':'fingerprint_and_prediction';
   items.push({filmId:id,lane:queue.priority?.[id]?.hot?'hot':'cold',plan,film,state,recoverySlot});added++;
  });
  return {added,deferred};
 };
 // Recovery slots first (ADR 0197): up to recoveryBatchSlots(cap) films with an active owner-confirmed intent, from both lanes, before the ordinary hot-first order. A pinned call keeps the
 // pin and is never reordered. A candidate that turns out current or without admission is skipped and does not use a slot.
 const recoverySlots=pin?0:recoveryBatchSlots(cap);
 const candidates=pin||!(overlay?.size>0)?null:queueRecoveryCandidates(queue,overlay,Date.now(),exclude);
 let recoveryTaken=0,probed=0;
 if(candidates&&recoverySlots>0){
  const pool=candidates.ids.slice(),unresolvedNot=new Set();
  while(recoveryTaken<recoverySlots&&pool.length&&probed<RECOVERY_SCAN_LIMIT&&scanned<BATCH_SCAN_LIMIT){
   const chunk=pool.splice(0,Math.min(recoverySlots-recoveryTaken,RECOVERY_SCAN_LIMIT-probed,BATCH_SCAN_LIMIT-scanned));
   scanned+=chunk.length;probed+=chunk.length;
   const result=await take(chunk,true);
   recoveryTaken+=result.added;
   result.deferred.forEach(id=>unresolvedNot.add(id));
  }
  // The quota is a cap on recovery films in the whole manifest: every other candidate (read or not) leaves the ordinary fill. Only a film read and found not to be unresolved recovery work stays ordinary.
  const candidateSet=new Set(candidates.ids);
  rest=rest.filter(id=>!candidateSet.has(id)||unresolvedNot.has(id));
 }
 // The ordinary queue fills every remaining slot with the unchanged hot-first order. The migration share (ADR 0035) applies to these slots: a recovery film carries no migration work, so it neither
 // uses nor widens that share. Read only as many film payloads as the client-requested cap needs: do not load a full 100-film payload set when the caller asked for five.
 while(items.length<cap&&rest.length&&scanned<BATCH_SCAN_LIMIT){
  const slots=cap-items.length;
  let chunk;
  if(pin)chunk=rest.splice(0,slots);
  else{chunk=queueBatchIds(queue,rest,slots);if(!chunk.length)break;const taken=new Set(chunk);rest=rest.filter(id=>!taken.has(id));}
  scanned+=chunk.length;
  await take(chunk,false);
 }
 // Counts only, never a film id or a payload: read-only diagnostics of what the recovery slots did.
 const recovery=candidates?{target:recoverySlots,selected:recoveryTaken,probed,ordinary:items.length-recoveryTaken,active:candidates.counts.active,eligible:candidates.counts.eligible,deferredByRetry:candidates.counts.deferredByRetry,retryExhausted:candidates.counts.retryExhausted,notQueued:candidates.counts.notQueued,noCandidates:candidates.ids.length===0}:null;
 return {items,skipped,notEligible,eligible:{hot:queue.priorityCount||0,cold:queue.coldRemaining??0,ready:ready.length},manifestSize:cap,scanned,...(recovery?{recovery}:{})};
}
// The manifest body, serialized once for its size and its hash. `runId` and `lease` are placeholders in a preflight (same width as the real values).
const batchFilmInputHash=async film=>(await contentHash({filmId:film.filmId,lane:film.lane,plan:film.plan,modelMetadata:film.modelMetadata,fingerprintHash:film.fingerprint?.fingerprintHash||null})).slice(0,24);
async function buildBatchManifest(env,{profile,items,runId,lease,dryRun=false,extra={}}){
 const registryDigest=(await fingerprintRegistryDigests()).registry,schema=enrichmentSchemaDocument();
 const films=items.map(item=>({filmId:item.filmId,lane:item.lane,plan:item.plan,modelMetadata:batchCompact(modelMetadata(item.film)),...(item.plan==='prediction_only'?{fingerprint:batchCompact(item.state.fingerprint)}:{})}));
 // A dry-run manifest names each film's input so a later dry-run submit can tell whether the film's input is still the manifest's.
 if(dryRun)for(const film of films)film.inputHash=await batchFilmInputHash(film);
 // The Scheduled Task keeps one tool result in its working context (AIR-510). The full schema document stays on GET /api/enrichment/schema and in the manifest hash.
 // The answer keeps the path the prompt reads (`schema.contract`) and the closed fingerprint vocabulary, and names the full document by schemaDigest.
 const fp=schema.fingerprint||{};
 const contract={fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,fingerprintPromptVersion:FINGERPRINT_PROMPT_VERSION,predictionPromptVersion:PREDICTION_PROMPT_VERSION,registryDigest,schema:{schemaDigest:await contentHash(schema),contract:schema.contract,fingerprint:{fingerprintSchemaVersion:fp.fingerprintSchemaVersion,plotMechanics:fp.plotMechanics,execution:fp.execution,requiredExecution:fp.requiredExecution,moodLabels:fp.moodLabels}}};
 const profileBlock={version:profile.version,hash:profile.profileHash,lineage:Array.isArray(profile.lineage)?profile.lineage:[],body:profile.profile};
 const manifestHash=await contentHash({manifestFormat:BATCH_MANIFEST_FORMAT,profileHash:profile.profileHash,contract:{...contract,schema:await contentHash(schema)},films:films.map(f=>({filmId:f.filmId,lane:f.lane,plan:f.plan,modelMetadata:f.modelMetadata,fingerprintHash:f.fingerprint?.fingerprintHash||null}))});
 // Films and profile before contract: a Scheduled Task that keeps only a prefix of the tool text still holds the five inputs (AIR-510 Task C, 16 Nov 2026).
 const body=batchStartAnswer({status:'running',runId,protocol:BATCH_PROTOCOL,dryRun,lease:{expiresAt:lease.expiresAt,ttlMs:RUNNER_LEASE_TTL,epoch:lease.epoch},limits:batchLimits(),manifestFormat:BATCH_MANIFEST_FORMAT,manifestHash,films,profile:profileBlock,contract,...extra});
 const bytes=new TextEncoder().encode(JSON.stringify(body)).length;
 const sizes=films.map(f=>new TextEncoder().encode(JSON.stringify(f)).length),largest=sizes.reduce((best,n,i)=>n>sizes[best]?i:best,0);
 return {body,hash:manifestHash,bytes,films:films.length,largestFilmBytes:sizes.length?sizes[largest]:0,largestFilmId:films[largest]?.filmId??null};
}
const batchOverflow=(manifest,extra={})=>batchBlocked('manifest_too_large',{bytes:manifest.bytes,limit:BATCH_RUNNER.maxManifestBytes,films:manifest.films,largestFilmBytes:manifest.largestFilmBytes,largestFilmId:manifest.largestFilmId,...extra});
const BATCH_START_KEY_ORDER=['status','runId','protocol','dryRun','lease','limits','manifestFormat','manifestHash','manifestSize','filmsSelected','films','profile'];
function batchStartAnswer(fields){
 const out={};
 for(const key of BATCH_START_KEY_ORDER)if(key in fields)out[key]=fields[key];
 for(const [key,value] of Object.entries(fields))if(!(key in out)&&key!=='contract')out[key]=value;
 if('contract' in fields)out.contract=fields.contract;
 return out;
}
const batchBytes=value=>new TextEncoder().encode(JSON.stringify(batchStartAnswer(value))).length;
// The fields that follow the manifest in the answer. A preflight measures the answer with the widest values these can take, so a manifest that passes it cannot grow past the
// limit when the real values are added; the exact answer is measured again before anything is persisted and before it is sent.
const batchPlaceholderExtras=(selection,dryRun)=>({manifestSize:selection.manifestSize??BATCH_RUNNER.maxManifestFilms,filmsSelected:99999999,queueRefreshed:true,queueSettled:99999999,eligible:{hot:99999999,cold:99999999,ready:99999999},skipped:{missingAdmission:99999999,alreadyCurrent:99999999},pendingCount:99999999,hotRemaining:99999999,coldRemaining:99999999,drained:{committed:99999999,dropped:99999999},...(selection.recovery?{recovery:{target:99999999,selected:99999999,probed:99999999,ordinary:99999999,active:99999999,eligible:{hot:99999999,cold:99999999},deferredByRetry:99999999,retryExhausted:99999999,notQueued:99999999,noCandidates:false}}:{}),...(dryRun?{notEligible:selection.notEligible}:{}),...scheduledRunFields()});
const batchRealExtras=(selection,queue,{queueRefreshed,queueSettled,dryRun})=>({manifestSize:selection.manifestSize??BATCH_RUNNER.maxManifestFilms,filmsSelected:selection.items.length,queueRefreshed,...(queueSettled?{queueSettled}:{}),eligible:selection.eligible,skipped:{missingAdmission:selection.skipped.missingAdmission.length,alreadyCurrent:selection.skipped.alreadyCurrent.length},pendingCount:queue.pending.length,hotRemaining:queue.priorityCount??null,coldRemaining:queue.coldRemaining??null,...(selection.recovery?{recovery:selection.recovery}:{}),...(dryRun?{notEligible:selection.notEligible}:{}),...scheduledRunFields()});
// Read-only. Reads the profile, the programme, the stored queue (and its own generation, the revision a later step compares) and the films; heals, rebuilds, settles and takes nothing.
// A queue that fails the advance gate is reported `stale`. `bytes` is the size of the whole answer with placeholder values for the fields only the real start knows.
// AIR-529, factored out by AIR-588 for the ordering writer: the cause a queue ranked on THIS completed generation is due for a re-rank, or null. `shows_signature_changed` and
// `window_transition` are ordering drift (ORDERING_DRIFT_CAUSES); `shows_signature_unreadable` is not (the basis cannot be verified at all).
async function sameGenerationPriority(env,stored,programme,now=Date.now()){
 const pinned=await queuePin(env,programme);
 const cause=showsSignatureCause(stored,programme,await currentShowsSignature(pinned,programme));
 if(cause)return {cause,deferred:false};
 const edge=windowTransitionState(stored,programme,now);
 return {cause:edge.cause,deferred:edge.deferred};
}
async function batchPreflight(env,body,tally=null){
 if(tally)tally.preflights++;
 const dryRun=body.dryRun===true,manifestSize=resolveManifestSize(body).size,[profile,report]=await Promise.all([loadJSON(env,profileKey),loadJSON(env,'programme.json')]);
 if(!profile)return {response:json({error:'Taste profile is not configured'},409)};
 const programme=report&&Array.isArray(report.films)?report:{runId:report?.runId||null,films:[]};
 const read=await readQueueHead(env),stored=read.current,revision=read.head?.queueGeneration??null,why=queueAdvanceGate(stored,programme,profile,(await fingerprintRegistryDigests()).registry,(await predictionRecoveryOverlay(env)).revision);
 const priorityOpen=!why&&!!stored&&(stored.priorityBasis==='carried'||stored.priorityBasis==='neutral'||stored.programmeRunId!==programme.runId);
 const sync=priorityOpen?await loadJSON(env,'sync.json'):null;
 let priorityDue=priorityOpen&&priorityRefreshDue(stored,programme,sync),priorityCause=priorityDue?'programme':null,priorityDeferred=false;
 // AIR-529: the same generation with new Discovery assignments. One read of the run's assigned rows per preflight, only on a queue ranked on this generation; no catalog scan.
 if(!why&&stored&&!priorityDue&&!priorityOpen&&stored.priorityBasis==='completed'&&stored.programmeRunId===programme.runId){
  const drift=await sameGenerationPriority(env,stored,programme);priorityCause=drift.cause;priorityDeferred=drift.deferred;
  priorityDue=!!priorityCause;
 }
 if(why)return {profile,report:programme,stale:why,priorityDue:false,revision,manifestSize};
 if(!stored)return {profile,report:programme,stale:'queue_shape',priorityDue:false,revision,manifestSize};
 try{
  const staged=dryRun?null:await loadJSON(env,BATCH_STAGE_KEY);
  const excludeIds=new Set((Array.isArray(staged?.items)?staged.items:[]).map(item=>item.filmId).filter(Boolean));
  const selection=await batchSelection(env,{profile,report:programme,queue:stored,pin:body.pin||null,limit:manifestSize,excludeIds});
  if(tally)tally.scannedFilms+=selection.scanned;
  const manifest=await buildBatchManifest(env,{profile,items:selection.items,runId:BATCH_PLACEHOLDER_RUN,lease:{expiresAt:Date.now()+RUNNER_LEASE_TTL,epoch:99999},dryRun});
  return {profile,report:programme,queue:stored,revision,selection,manifest,manifestSize,priorityDue,priorityCause,priorityDeferred,bytes:batchBytes({...manifest.body,...batchPlaceholderExtras(selection,dryRun)})};
 }catch(error){
  if(CATALOG_HELD_CODES.includes(error?.code))return {response:catalogHeldResponse(error.code)};
  throw error;
 }
}
const batchOverflowOf=(pre,extra={})=>batchOverflow({...pre.manifest,bytes:pre.bytes},extra);
// The queue refresh and the settlement that D7-A names as effects of batch_start: a queue that fails the advance gate is refreshed (not rebuilt on every start), and the films the
// preflight found already current or without an admission leave the queue in one guarded settlement. The caller reads the result again as a fresh preflight, its new baseline.
// The settlement looks at the films the manifest would be built from (the client-requested size), not at a default 100: a film behind that window leaves the queue when it is reached.
// ---- AIR-588 (A2, ADR 0204): ordering drift leaves the synchronous start; one named, bounded writer rebuilds it. ----
// Ordering drift is a re-rank the stored queue owes to its OWN completed generation: a changed assigned-shows signature (Discovery assigned shows inside the generation) or a reached
// window edge past its 15-minute rate cap. It never covers an unreadable signature, a new or carried generation or a queue that fails the advance gate.
const ORDERING_DRIFT_CAUSES=new Set(['shows_signature_changed','window_transition']);
// The start defers a drift only while the stored queue was rebuilt less than this long ago; an older queue is refreshed by the start as before, so a writer that never runs (a failed
// tick, a lease that is never free) cannot leave the ranking stale for longer than this.
const ORDERING_MAX_LAG_MS=90*60000;
// The writer waits at most this long for a moment without a start or a submit in flight, checking every ORDERING_POLL_MS; then it gives the tick up (the next tick or the start's lag bound repairs).
const ORDERING_WAIT_MS=5*60000,ORDERING_POLL_MS=15000;
function orderingDeferrable(pre,now=Date.now()){
 if(!ORDERING_DRIFT_CAUSES.has(pre?.priorityCause))return false;
 // A queue ranked while the signature could not be read stores none: its basis was never verified, so it is not a proven drift and the start rebuilds it as before.
 if(typeof pre.queue?.showsSignature!=='string'||!pre.queue.showsSignature)return false;
 if(!(pre.selection?.items?.length>0))return false;
 const built=Date.parse(pre.queue?.refreshedAt||'');
 return Number.isFinite(built)&&now-built<ORDERING_MAX_LAG_MS;
}
// A start (its claim) or a commit (the persist or submit gate) holds the runner lease: the writer does not rebuild under it, so it never moves the queue between a start's preflight and
// its revalidation, nor under a gated commit. A run in its research phase (lease live, no gate) does not block it: its submits settle through the guarded settlement on whatever queue is stored.
async function predictionRunnerBusy(env,now=Date.now()){
 const lease=await loadJSON(env,RUNNER_LEASE_KEY);
 if(!(lease?.runId&&Number(lease.expiresAt)>now))return false;
 return lease.phase==='claim'||(!!lease.submitGate&&Number(lease.submitGate.expiresAt)>now);
}
// The admission of the ordering writer, decided on ONE snapshot: the stored queue head and the profile and programme read for it. Null when admitted (with the drift cause in `out`), otherwise
// the outcome and reason to report. Only a queue that passes the advance gate, is ranked on this completed generation with a verified signature and owes ordering drift is admitted.
async function orderingAdmission(env,stored,programme,profile,now){
 if(!profile||!programme?.runId)return {outcome:'skipped',reason:'inputs'};
 if(!stored)return {outcome:'skipped',reason:'no_queue'};
 // A queue that fails the advance gate, or one not ranked on this completed generation, is the start's to refresh (or refuse): never this writer's.
 if(queueAdvanceGate(stored,programme,profile,(await fingerprintRegistryDigests()).registry,(await predictionRecoveryOverlay(env)).revision))return {outcome:'skipped',reason:'not_current'};
 if(stored.priorityBasis!=='completed'||stored.programmeRunId!==programme.runId)return {outcome:'skipped',reason:'not_same_generation'};
 if(typeof stored.showsSignature!=='string'||!stored.showsSignature)return {outcome:'skipped',reason:'unverified_basis'};
 const drift=await sameGenerationPriority(env,stored,programme,now);
 if(!drift.cause)return {outcome:'current',...(drift.deferred?{deferred:true}:{})};
 if(!ORDERING_DRIFT_CAUSES.has(drift.cause))return {outcome:'skipped',reason:drift.cause};
 return {admitted:true,cause:drift.cause};
}
// A rebuilt candidate is written only when it is again a current, verified ranking of the SAME completed generation as the head it replaces: a build whose signature read failed (stored
// `showsSignature: null`) or whose basis or generation moved is refused, never published.
function orderingCandidateRefusal(candidate,stored,programme,profile,registry,recoveryRevision){
 if(!candidate)return 'no_candidate';
 if(queueAdvanceGate(candidate,programme,profile,registry,recoveryRevision))return 'candidate_not_current';
 if(candidate.priorityBasis!=='completed'||candidate.programmeRunId!==programme.runId||candidate.programmeRunId!==stored.programmeRunId)return 'candidate_basis_changed';
 if(typeof candidate.showsSignature!=='string'||!candidate.showsSignature)return 'candidate_unverified';
 return null;
}
// The writer, called once per hourly tick. Writes nothing unless the stored queue is current for its generation and owes an ordering re-rank. Every attempt (the first and each retry after a lost
// compare-and-swap) reads the queue head, the profile and the programme afresh and decides the admission on that snapshot, builds from the same inputs, refuses a candidate that is not a verified
// ranking of the same generation, re-checks the runner lease and only then writes against that head. A repair by another writer in the meantime ends the tick as `current`. One sanitized log line.
async function reconcilePredictionOrdering(env,{now=Date.now(),waitMs=ORDERING_WAIT_MS,pollMs=ORDERING_POLL_MS,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),hooks=null}={}){
 const started=Date.now();
 const done=(outcome,extra={})=>{const line={event:'prediction_ordering_reconcile',outcome,...extra,ms:Date.now()-started};try{console.log(JSON.stringify(line));}catch{/* a log line never changes the outcome */}return line;};
 try{
  const authority=typeof PredictionD1==='undefined'?null:await PredictionD1.readPredictionAuthority(env?.DB??null,env);
  if(authority?.mode!=='d1')return done('skipped',{reason:'authority'});
  const snapshot=async()=>{
   const head=await PredictionD1.openQueue(env);
   const [profile,report]=await Promise.all([loadJSON(env,profileKey),loadJSON(env,'programme.json')]);
   return {head,stored:head?.queue??null,profile,programme:report&&Array.isArray(report.films)?report:null};
  };
  // A first admission before any wait: a tick with nothing to do ends here.
  {const first=await snapshot(),admission=await orderingAdmission(env,first.stored,first.programme,first.profile,now);if(!admission.admitted){const {outcome,...rest}=admission;return done(outcome,rest);}}
  for(let waited=0;;waited+=pollMs){
   if(!await predictionRunnerBusy(env))break;
   if(waited+pollMs>waitMs)return done('skipped',{reason:'busy'});
   await sleep(pollMs);
  }
  for(let attempt=0;attempt<PREDICTION_QUEUE_ATTEMPTS;attempt++){
   await predictionQueuePause(attempt);
   const {head,stored,profile,programme}=await snapshot();
   const admission=await orderingAdmission(env,stored,programme,profile,Date.now());
   if(!admission.admitted){const {outcome,...rest}=admission;return done(outcome,{...rest,...(attempt?{attempts:attempt+1}:{})});}
   if(hooks?.beforeBuild)await hooks.beforeBuild(attempt);
   const candidate=await buildPredictionQueue(env,programme,'ordering_reconcile',stored);
   const refused=orderingCandidateRefusal(candidate,stored,programme,profile,(await fingerprintRegistryDigests()).registry,(await predictionRecoveryOverlay(env)).revision);
   if(refused)return done('skipped',{reason:refused,cause:admission.cause});
   if(await predictionRunnerBusy(env))return done('skipped',{reason:'busy_at_write',cause:admission.cause});
   if(hooks?.beforeWrite)await hooks.beforeWrite(attempt);
   if(await PredictionD1.writeQueue(env,head,candidate)!==null)return done('rebuilt',{cause:admission.cause,...(attempt?{attempts:attempt+1}:{})});
  }
  return done('skipped',{reason:'contended'});
 }catch(error){
  const code=typeof error?.code==='string'&&/^[a-z][a-z0-9_]{1,63}$/.test(error.code)?error.code:'error';
  return done('failed',{code});
 }
}
async function batchRefreshQueue(env,body,pre,tally=null){
 let queue=pre.queue,settled=0;const limit=resolveManifestSize(body).size;
 if(pre.stale||pre.priorityDue)queue=await currentPredictionQueue(env,pre.report,pre.profile,body.trigger==='scheduled'?'scheduled':'manual',{force:!pre.stale&&!!pre.priorityDue,fallback:true});
 const context=await advanceContext(env,pre.report,pre.profile,queue);
 for(let round=0;round<3;round++){
  const selection=await batchSelection(env,{profile:pre.profile,report:pre.report,queue,limit}),settle=[...selection.skipped.missingAdmission,...selection.skipped.alreadyCurrent];
  if(tally){tally.refreshRounds++;tally.scannedFilms+=selection.scanned;}
  if(!settle.length)break;
  const next=await mutatePredictionQueue(env,guardedSettle(context,settle,'batch_start_settle'),'batch_start_settle',queue)||queue;
  if(next===queue)break;
  settled+=settle.length;queue=next;
  if(tally)tally.settledFilms+=settle.length;
 }
 return {queue,settled};
}
// A live runner lease turns a real start away; it is recorded as a start attempt and nothing else is written.
async function batchTurnedAway(env,body,tally=null,requestId=null,extra={}){
 const live=await loadJSON(env,RUNNER_LEASE_KEY);
 if(!(live?.runId&&live.expiresAt>Date.now()))return null;
 if(tally){tally.leaseRefused=1;const age=leaseAgeMs(live);if(Number.isFinite(age))tally.liveLeaseAgeMs=Math.max(0,age);}
 const turned={runId:crypto.randomUUID(),createdAt:new Date().toISOString(),trigger:body.trigger==='scheduled'?'scheduled':'manual',status:'completed',selectedIds:[],results:{},failures:{}};
 turned.diagnosticStartedAt=turned.createdAt;turned.completedAt=turned.createdAt;
 await diagnosticCheckpoint(env,turned,{startResult:'already_running'});
 await recordSkippedStart(env,{requestId,body,holder:live});
 return json({status:'already_running',runId:live.runId,expiresAt:live.expiresAt,...extra});
}
// Nothing eligible, or no capacity: the ordinary idle outcome of a start (`noop`, or `blocked` for `quota` and `retry_backoff`). No lease is taken and no run exists, so it is not passed
// through the stop recorder, which would manufacture a stopped run, a stop Event and a `latest-run` for it. The attempt is recorded and the queue's `lastBatch` is kept, as a v5 start does.
// AIR-529: the read-only statement, in the dry-run answer, that the hot count of a start does NOT rest on a current basis: the cause is named, `hotRemaining` is the queue's own count and may be stale, never a verified 0.
// It is present only when degraded: the dry-run answer of a current queue is unchanged (the start parity baseline pins its shape). This does NOT recompute hot outstanding from the catalog on a start. The independent comparison is
// the read-only `prediction_hot_parity` tool (`predictionHotParity`), which runs this very builder in memory instead of keeping a second copy of the rules; a start never pays for it.
function hotBasisOf(pre){
 const queue=pre.queue||null;
 return {status:'degraded',cause:pre.priorityCause||'programme',hotRemaining:Number.isInteger(queue?.priorityCount)?queue.priorityCount:null,programmeRunId:queue?.programmeRunId??null,showsSignature:queue?.showsSignature??null,nextChangeAt:queue?.priorityNextChangeAt??null};
}
async function batchIdle(env,body,pre){
 const plan=adaptivePredictionBatch(pre.queue,body.capacity);
 if(plan.reason!=='quota'&&pre.selection.items.length)return null;
 if(plan.reason!=='quota'&&!pre.selection.items.length){
  const staged=await loadJSON(env,BATCH_STAGE_KEY);
  if(Array.isArray(staged?.items)&&staged.items.length)return null;
 }
 const idle={runId:crypto.randomUUID(),createdAt:new Date().toISOString(),trigger:body.trigger==='scheduled'?'scheduled':'manual',status:'starting',selectedIds:[],results:{},failures:{}};idle.diagnosticStartedAt=idle.createdAt;
 const result=await predictionWriter(env,()=>startIdle(env,{body,profile:pre.profile,queue:pre.queue,plan}));
 const data=await result.clone().json();
 idle.status=data.status==='noop'?'idle':data.status==='busy'?'completed':'blocked';idle.completedAt=new Date().toISOString();idle.stopReason=data.status==='blocked'?data.reason||null:null;
 await diagnosticCheckpoint(env,idle,{startResult:['blocked','noop'].includes(data.status)?data.status:'error'});
 return result;
}
// What a refusal of the manifest never does: it creates no run, Event, diagnostics row or `latest-run`, and it does not pass through the start's stop recorder.
// AIR-542: the proof that a queue revision or manifest change between the baseline preflight and the post-lease preflight is a re-rank and nothing else. Returns null when proven, else the
// refusal cause. The proof compares the queue itself, not the manifest hash: every field outside PRIORITY_QUEUE_FIELDS (work and migration share compared per film and independent of key
// order, retries, last batch, profile, contract, compatibility versions, recovery revision, shape) must be equal, and so must the set of queued films. `pending`, `hotPending` and `coldPending`
// are ordered by rank and `pending` takes every hot film, so a real rebuild that promotes a film reorders and resizes `pending`: only the union of the three is compared. A change that decides WHICH films may be selected is never a re-rank. A rank-only
// revision may leave the delivered manifest byte-identical (films outside the first `manifestSize` re-ranked): that is proven the same way and the run continues. When the manifest differs the
// films present in both must keep plan, metadata and fingerprint, and a film the new selection dropped must not have been skipped as no longer admitted or current, nor be staged elsewhere.
// `again` was read under the owned lease, so it stays the manifest that is delivered.
const PRIORITY_QUEUE_FIELDS=new Set(['pending','work','hotCount','coldCount','coldWithoutPrediction','hotPredicted','priority','priorityBasis','priorityAsOf','priorityCount','priorityNextChangeAt','showsSignature','urgentCount','coldRemaining','hotPending','coldPending','refreshedAt','trigger','metrics','discovery','compatibility']);
async function priorityOnlyRebaseCause(env,pre,again){
 if(again.report?.runId!==pre.report?.runId||again.queue?.programmeRunId!==pre.queue?.programmeRunId)return 'programme';
 const a=pre.manifest.body,b=again.manifest.body;
 if(a.profile?.hash!==b.profile?.hash||JSON.stringify(a.contract)!==JSON.stringify(b.contract))return 'contract';
 // Canonical: object keys sorted at every depth. A real rebuild orders `pending` by priority and builds `work` in that order, so neither list order nor key insertion order is meaning.
 const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
 const rest=queue=>{const out={};for(const key of Object.keys(queue))if(!PRIORITY_QUEUE_FIELDS.has(key))out[key]=queue[key];return JSON.stringify(stable(out));};
 const set=list=>JSON.stringify([...new Set(list||[])].sort());
 const members=queue=>set([...(queue.pending||[]),...(queue.hotPending||[]),...(queue.coldPending||[])]);
 if(rest(pre.queue)!==rest(again.queue)||members(pre.queue)!==members(again.queue))return 'queue';
 // `work` is built for the films of `pending` only, so a promoted film gains an entry and a demoted one loses it: that follows the rank. For every film that has one on both sides the classification
 // (class, migration, reason, fields) must be equal, which is what the migration-share cap reads.
 const w0=pre.queue.work||{},w1=again.queue.work||{};
 for(const id of Object.keys(w0))if(id in w1&&JSON.stringify(stable(w0[id]))!==JSON.stringify(stable(w1[id])))return 'queue';
 // An entry may appear only for a film that ENTERED `pending` (not in it before, in it now) and disappear only for one that LEFT it. A film pending on both sides keeps its entry: adding or
 // deleting it changes the migration share, which is not a re-rank.
 const p0=new Set(pre.queue.pending||[]),p1=new Set(again.queue.pending||[]);
 for(const id of Object.keys(w1))if(!(id in w0)&&!(!p0.has(id)&&p1.has(id)))return 'queue';
 for(const id of Object.keys(w0))if(!(id in w1)&&!(p0.has(id)&&!p1.has(id)))return 'queue';
 if(again.manifest.hash===pre.manifest.hash)return null;
 // The queue's selection inputs are the same, so a different manifest under an unchanged revision is a change of film state, not of rank.
 if(again.revision===pre.revision)return 'manifest';
 const content=f=>JSON.stringify([f.plan,f.modelMetadata,f.fingerprint?.fingerprintHash||null]);
 const oldFilms=new Map(a.films.map(f=>[f.filmId,f])),newFilms=new Map(b.films.map(f=>[f.filmId,f]));
 for(const [id,f] of newFilms)if(oldFilms.has(id)&&content(oldFilms.get(id))!==content(f))return 'manifest';
 const dropped=[...oldFilms.keys()].filter(id=>!newFilms.has(id));
 if(dropped.length){
  const gone=new Set([...again.selection.skipped.missingAdmission,...again.selection.skipped.alreadyCurrent]);
  const staged=await loadJSON(env,BATCH_STAGE_KEY),stagedIds=new Set((Array.isArray(staged?.items)?staged.items:[]).map(item=>item.filmId));
  for(const id of dropped)if(gone.has(id)||stagedIds.has(id))return 'manifest';
 }
 return null;
}
// What a start did, for the step-timing line: counters only (no ids, keys or payloads). `tally` is one request's own object.
async function batchStartRoute(env,body,requestId){
 const tally={preflights:0,refreshRounds:0,scannedFilms:0,settledFilms:0};
 try{const response=await batchStartWork(env,body,requestId,tally);await recordCatalogHeldStart(env,{body,requestId,response});return response;}
 finally{noteStep(env,()=>tally);}
}
// AIR-575 (ADR 0190). Every real start the Worker refuses with HTTP 503 `prediction_catalog_held` (the global gate, the queue refresh, the revalidation under the lease and the persist step all answer the same body)
// leaves one neutral skipped Event of that request, recorded at this single exit so no refusal path can be missed or counted twice. A dry run writes nothing. Best effort: it never throws and never changes the 503.
async function recordCatalogHeldStart(env,{body,requestId,response}){
 try{
  if(body?.dryRun===true||response?.status!==503)return;
  const data=await response.clone().json();
  if(data?.code!=='prediction_catalog_held'||!CATALOG_HELD_CODES.includes(data.cause))return;
  await recordSkippedStart(env,{requestId,body,reason:'catalog_held',cause:data.cause});
 }catch{/* the refusal is unchanged */}
}
// ADR 0188. A keyed real start (invocationKey present, not a dry run) claims the runner lease before its heavy preflights and joins its own live run when the same invocation repeats the
// start. A start without a key, and every dry run, takes the unchanged path. The key is reduced to a hash here and never travels further: no log, row or diagnostic carries it.
const startArgsOf=body=>({scope:body.scope,mode:body.mode||'queued',trigger:body.trigger==='scheduled'?'scheduled':'manual',manifestSize:resolveManifestSize(body).size,capacity:body.capacity||null});
const claimRenewed=(env,claim)=>runnerLeaseEdit(env,claim.runId,claim.epoch,(old,now)=>old.phase==='claim'?{value:{...old,heartbeatAt:new Date(now).toISOString(),expiresAt:now+START_CLAIM_TTL_MS}}:{refuse:{status:'owned'}});
// AIR-588 (A1): the read-only check of a young claim. It writes nothing: the lease is still this run's and epoch's and alive (runnerLeaseEdit refuses otherwise), whatever its phase, exactly the cases claimRenewed accepts.
const claimHeld=(env,claim)=>runnerLeaseEdit(env,claim.runId,claim.epoch,()=>({refuse:{status:'owned'}}));
const CLAIM_READ_WINDOW_MS=30000;
const claimConverted=(env,claim)=>runnerLeaseEdit(env,claim.runId,claim.epoch,(old,now)=>old.phase==='claim'?{value:{...old,phase:'run',heartbeatAt:new Date(now).toISOString(),expiresAt:now+(claim.deferred?READY_LEASE_TTL_MS:RUNNER_LEASE_TTL)}}:{refuse:{status:'owned'}});
// The readiness boundary of a deferred run (ADR 0193): ONE owner-fenced lease edit removes the persist gate and the preparation mark and keeps the short expiry unless the client already renewed
// (an acknowledged renewal is never shortened). The manifest is not served before this edit has happened (`ownedBatchManifest` answers pending while `prep` is set).
const startReady=(env,claim,token)=>runnerLeaseEdit(env,claim.runId,claim.epoch,(old,now)=>{
 if(old.submitGate?.token!==token)return {refuse:{status:'gate_lost'}};
 const {submitGate,prep,...rest}=old;void submitGate;void prep;
 return {value:{...rest,heartbeatAt:new Date(now).toISOString(),expiresAt:old.clientAckAt?old.expiresAt:now+READY_LEASE_TTL_MS}};
});
// ADR 0194: the readiness edit of a deferred run when the auxiliary state is in D1. The lease edit is the same one `startReady` makes (gate and `prep` removed, the short expiry kept when the client already
// acknowledged), composed with the manifest rows into one batch guarded by the runner lease (run id, epoch, gate token, `prep` still set). A client heartbeat that lands between the read and the batch moves
// the prediction generation, so the batch fails closed and this re-reads: a legitimate heartbeat is never read as a lost lease and its acknowledgement is preserved.
async function auxStartReadyWithManifest(env,aux,claim,token,answer){
 for(let attempt=1;attempt<=RUNNER_LEASE_ATTEMPTS;attempt++){
  const head=await PredictionD1.openLease(env,RUNNER_LEASE_KEY),old=head.value,now=Date.now();
  if(!old||old.runId!==claim.runId||old.expiresAt<=now||previousEpochOf(old)!==claim.epoch)return {status:'lease_lost'};
  if(old.submitGate?.token!==token)return {status:'gate_lost'};
  const {submitGate,prep,...rest}=old;void submitGate;void prep;
  const value={...rest,heartbeatAt:new Date(now).toISOString(),expiresAt:old.clientAckAt?old.expiresAt:now+READY_LEASE_TTL_MS};
  const {statements}=PredictionD1.leaseStatements(head,'runner',value,head.token);
  try{await PredictionAux.writeManifest(auxDb(env),aux,claim.runId,answer,{guard:{runId:claim.runId,epoch:claim.epoch,token},prep:true,extra:statements});}
  catch(error){if(error?.code==='prediction_aux_cas'||error?.code==='prediction_domain_cas'){if(attempt<RUNNER_LEASE_ATTEMPTS)continue;return {status:'busy'};}throw error;}
  await PredictionD1.mirrorLease(env,'runner',value);
  return {status:'owned',value};
 }
 return {status:'busy'};
}
// A same-key repeat of the live run: the stored start answer if it exists, else a bounded wait and then `start_pending`. It writes nothing and never extends a TTL. The holder is read again
// immediately before anything is returned: the current lease must still be live, still carry this key and argument hash, and no client submit may have closed the window (ADR 0188).
async function batchJoin(env,live,tally,ids,refuse,envelope=false){
 const joinable=async()=>{const current=await loadJSON(env,RUNNER_LEASE_KEY);return current?.runId===live.runId&&Number(current.expiresAt)>Date.now()&&current.keyHash===ids.keyHash&&current.argsHash===ids.argsHash&&(ids.taskId?current.taskId===ids.taskId&&current.epoch===live.epoch:!current.clientSubmitAt);};
 const until=Date.now()+JOIN_WAIT_MS,key=ENRICHMENT_KEY+'batch-manifest/'+live.runId+'.json';
 for(;;){
  const stored=await loadJSON(env,key);
  if(usableBatchManifest(stored)){if(!await joinable())return refuse();tally.joined=1;if(envelope){tally.envelopeAnswer=1;return json(batchStartEnvelope(stored));}return json(stored);}
  if(Date.now()>=until)break;
  await new Promise(resolve=>setTimeout(resolve,1000));
  if(!await joinable())return refuse();
 }
 if(!await joinable())return refuse();
 tally.joined=1;tally.startPending=1;
 return json({status:'start_pending',runId:live.runId,epoch:live.epoch??null,retryAfterMs:2000,...(ids.taskId?{taskId:ids.taskId,read:{tool:'prediction_batch_manifest',part:'envelope',pendingCode:'manifest_pending'}}:{}),...scheduledRunFields()});
}
// ---- ADR 0193: deferred start. The start accepts a bounded claim and answers a compact receipt within seconds; the heavy preparation runs in a Cloudflare Workflow instance (one per run id) that
// does not depend on the MCP request's lifetime, and the caller reads the immutable manifest through `prediction_batch_manifest`. ----
const startReceipt=(runId,epoch,phase,extra={})=>({status:'accepted',protocol:BATCH_PROTOCOL,deferred:true,runId,epoch:epoch??null,phase,next:phase==='accepting'?'repeat_start':'poll_manifest',retryAfterMs:phase==='accepting'?1000:START_POLL_MS,read:{tool:'prediction_batch_manifest',part:'envelope',pendingCode:'manifest_pending'},...extra,...scheduledRunFields()});
// The typed answers of an invocation whose attempt ended without a run: the same words the readback uses. A retry never launches a second preparation for the same key.
const startOutcomeAnswer=(outcome,runId)=>json({status:'blocked',reason:outcome.phase==='refused'?'start_refused':'start_failed',code:outcome.phase==='refused'?'start_refused':'start_failed',outcomeCode:outcome.code||null,outcomeReason:outcome.reason||null,runId,...scheduledRunFields()},409);
// Create-only records under enrichment/batch-start/: the terminal outcome of a run and the marker that its Workflow instance exists. A replayed or stale instance never overwrites either.
async function writeCreateOnly(env,key,doc){
 // 'created' | 'exists' (the record was already there) | 'error' (unknown: the record may or may not exist).
 try{const saved=await env.BUCKET.put(key,JSON.stringify({at:new Date().toISOString(),...doc}),{httpMetadata:{contentType:'application/json'},onlyIf:{etagDoesNotMatch:'*'}});return saved===null?'exists':'created';}
 catch{return 'error';}
}
const writeStartOutcome=(env,runId,doc)=>writeCreateOnly(env,START_OUTCOME_PREFIX+runId+'.json',{runId,...doc});
const writeStartAttempt=(env,runId,doc)=>writeCreateOnly(env,START_ATTEMPT_PREFIX+runId+'.json',{runId,...doc});
// Whether a Workflow instance with this id exists: 'yes', 'no' (the platform says it is not found) or 'unknown' (anything else, including a missing `get`).
async function startInstanceState(binding,id){
 if(typeof binding?.get!=='function')return 'unknown';
 try{await binding.get(id);return 'yes';}
 catch(error){return /not[ _.-]?found|does not exist/i.test(String(error?.message||error))?'no':'unknown';}
}
// A repeat of an invocation whose own attempt is live: the same receipt, never a second preparation and never a wait. The holder is read again after the records, so a takeover between the reads is refused.
async function batchReceiptFor(env,live,tally,refuse){
 tally.deferredReplay=1;
 const [attempt,stored]=await Promise.all([loadJSON(env,START_ATTEMPT_PREFIX+live.runId+'.json'),loadJSON(env,ENRICHMENT_KEY+'batch-manifest/'+live.runId+'.json')]);
 const current=await loadJSON(env,RUNNER_LEASE_KEY);
 if(!(current?.runId===live.runId&&Number(current.expiresAt)>Date.now()&&current.keyHash===live.keyHash&&current.argsHash===live.argsHash&&!current.clientSubmitAt))return refuse();
 // `accepting`: the first request has claimed but not yet written its attempt marker: repeat the same start. `ready`: stored and served (the readiness edit removed `prep`).
 const phase=!attempt?'accepting':(usableBatchManifest(stored)&&!current.prep)?'ready':'preparing';
 return json(startReceipt(live.runId,current.epoch,phase));
}
// What is already known about an invocation, in a fixed order: its terminal outcome, a live attempt of the same key, a finished run, an attempt that was dispatched and ended unrecorded. A Response when
// something is known, `null` when no attempt of this key ever claimed and wrote its marker (a new one may start). One attempt per key: a marker is the durable evidence that a dispatch is possible.
async function startDecision(env,runId,clean,tally,requestId,argsHash){
 const refuse=async()=>(await batchTurnedAway(env,clean,tally,requestId))||batchBlocked('start_owner_lost',{runId});
 const [outcome,live,attempt]=await Promise.all([loadJSON(env,START_OUTCOME_PREFIX+runId+'.json'),loadJSON(env,RUNNER_LEASE_KEY),loadJSON(env,START_ATTEMPT_PREFIX+runId+'.json')]);
 if(outcome&&(outcome.phase==='refused'||outcome.phase==='failed'))return startOutcomeAnswer(outcome,runId);
 const own=live?.runId===runId&&Number(live.expiresAt)>Date.now()?live:null;
 if(own){
  if(own.argsHash!==argsHash){tally.keyArgsMismatch=1;return (await batchTurnedAway(env,clean,tally,requestId,{reason:'key_args_mismatch'}))||refuse();}
  if(own.clientSubmitAt)return refuse();
  return batchReceiptFor(env,own,tally,refuse);
 }
 // A `ready` outcome without a live lease: the run finished or its short lease expired. Nothing is started again for this key.
 if(outcome&&outcome.phase==='ready')return json({status:'blocked',reason:'start_finished',code:'start_finished',runId,...scheduledRunFields()},409);
 // A marker with no live holder and no outcome: the attempt ended unrecorded. Recorded once as failed, never dispatched again.
 if(attempt){
  await writeStartOutcome(env,runId,{phase:'failed',code:'start_claim_lost'});
  return startOutcomeAnswer((await loadJSON(env,START_OUTCOME_PREFIX+runId+'.json'))||{phase:'failed',code:'start_claim_lost'},runId);
 }
 return null;
}
// The deferred start of one invocation (the key was issued by the server). ONE ATTEMPT PER KEY: after the claim, the create-only attempt marker is written BEFORE the Workflow instance is created, so a
// marker exists whenever a dispatch is possible, even if this request then dies. A claim that finds the marker already there lost the race to an earlier attempt: it releases itself (fenced by its own
// epoch) and answers what is known; it never dispatches. A claim without a marker never reached the platform, so the same key may claim again.
async function deferredStart(env,clean,requestId,tally,{keyHash,argsHash}){
 const runId=deferredRunIdOf(keyHash),binding=env?.PREDICTION_START_WORKFLOW,bound=!!binding&&typeof binding.create==='function';
 const unavailable=(code,extra={})=>{tally.deferredUnavailable=1;return json({status:'blocked',reason:code,code,...extra,...scheduledRunFields()},503);};
 const known=await startDecision(env,runId,clean,tally,requestId,argsHash);
 if(known)return known;
 if(!bound)return unavailable('deferred_start_unavailable');
 forgetAuthority(env);
 const taken=await timedStage(env,'start_claim',()=>atStage('start_claim',()=>runnerLease(env,runId,'acquire',{keyHash,argsHash,deferred:true,taskId:clean.taskId})));
 if(taken.status!=='owned'){
  const holder=await loadJSON(env,RUNNER_LEASE_KEY);
  if(holder?.runId===runId&&Number(holder.expiresAt)>Date.now()&&holder.keyHash===keyHash&&holder.argsHash===argsHash&&!holder.clientSubmitAt)return batchReceiptFor(env,holder,tally,async()=>(await batchTurnedAway(env,clean,tally,requestId))||batchBlocked('start_owner_lost',{runId}));
  return (await batchTurnedAway(env,clean,tally,requestId))||json(leaseRefusalAnswer(taken));
 }
 tally.keyed=1;
 const releaseMine=()=>runnerLease(env,runId,'release',null,taken.epoch).catch(()=>null);
 const marked=await writeStartAttempt(env,runId,{argsHash,epoch:taken.epoch});
 if(marked==='exists'){
  // An earlier attempt of this key already used it (it may have finished and released while this request was between its reads and its claim): this claim is not a dispatch.
  await releaseMine();
  return (await startDecision(env,runId,clean,tally,requestId,argsHash))||unavailable('deferred_start_unavailable');
 }
 if(marked==='error'){await releaseMine();return unavailable('deferred_start_unavailable');}
 const {deferred,...body}=clean;void deferred;
 const params={runId,epoch:taken.epoch,keyHash,argsHash,recoveredRunId:taken.recoveredRunId||null,requestId:SAFE_LOG_ID.test(String(requestId))?requestId:null,body};
 let dispatched='yes';
 try{await binding.create({id:runId,params});}
 catch(error){
  logPredictionFailure('start',error,requestId,runId);
  // An error from `create` is not proof that nothing was created: the instance identity is the run id, so ask the platform. An instance that exists keeps the claim (it may already be preparing); a
  // definite "not found" ends this one-shot attempt typed; an unknown state keeps the claim and says so, bounded by the 180 s claim.
  dispatched=await startInstanceState(binding,runId);
  if(dispatched==='no'){await writeStartOutcome(env,runId,{phase:'failed',code:'deferred_start_unavailable'});await releaseMine();return unavailable('deferred_start_unavailable');}
 }
 if(dispatched==='unknown')return unavailable('deferred_start_ambiguous',{runId,retryAfterMs:1000});
 tally.deferredAccepted=1;
 return json(startReceipt(runId,taken.epoch,'preparing',{lease:{epoch:taken.epoch,claimTtlMs:START_CLAIM_TTL_MS,readyTtlMs:READY_LEASE_TTL_MS,ttlMs:RUNNER_LEASE_TTL}}));
}
// The Workflow side: one durable step prepares the run exactly as a synchronous keyed start would (same preflights, revalidation, fencing and persist), then records a small terminal outcome.
// No retry: a repeated preparation could only duplicate work; a failure ends with the claim released and a typed outcome. The instance is bound to the epoch it was dispatched with: a claim that is
// not live, not this key's or of another epoch ends it before any side effect.
async function predictionStartPrepare(env,payload){
 const started=Date.now();
 const runId=payload?.runId;
 if(!isText(runId,100)||!DEFERRED_RUN_PATTERN.test(runId)||!Number.isInteger(payload?.epoch)||!isObject(payload?.body)||!/^[0-9a-f]{64}$/.test(String(payload.keyHash))||!/^[0-9a-f]{64}$/.test(String(payload.argsHash))||runId!==deferredRunIdOf(payload.keyHash))return {phase:'failed',code:'invalid_payload'};
 const tally={preflights:0,refreshRounds:0,scannedFilms:0,settledFilms:0,keyed:1,deferred:1};
 const finish=async(phase,extra={})=>{
  const outcome={phase,...extra};
  await writeStartOutcome(env,runId,outcome);
  try{console.log(JSON.stringify({event:'prediction_start_prepared',runId:SAFE_LOG_ID.test(runId)?runId:null,requestId:SAFE_LOG_ID.test(String(payload.requestId))?payload.requestId:null,phase,code:SAFE_LOG_ID.test(String(extra.code))?extra.code:null,prepareMs:Date.now()-started,preflights:tally.preflights,refreshRounds:tally.refreshRounds,scannedFilms:tally.scannedFilms,settledFilms:tally.settledFilms,claimRenewals:tally.claimRenewals||0}));}catch{/* a log never changes the outcome */}
  return outcome;
 };
 const lease=await loadJSON(env,RUNNER_LEASE_KEY);
 if(!(lease?.runId===runId&&lease.epoch===payload.epoch&&lease.phase==='claim'&&Number(lease.expiresAt)>Date.now()&&lease.keyHash===payload.keyHash&&lease.argsHash===payload.argsHash))return finish('failed',{code:'start_claim_lost'});
 const epoch=payload.epoch;
 const claim={runId,epoch,keyHash:payload.keyHash,argsHash:payload.argsHash,lease:{...lease,status:'owned',...(payload.recoveredRunId?{recoveredRunId:payload.recoveredRunId}:{})},converted:false,deferred:true};
 let response=null,failure=null;
 const requestId=payload.requestId||crypto.randomUUID();
 try{response=await batchStartCore(env,payload.body,requestId,tally,claim);}
 catch(error){failure=error;logPredictionFailure('start',error,payload.requestId,runId);}
 finally{if(!claim.converted)await runnerLease(env,runId,'release',null,epoch).catch(()=>null);}
 if(failure){if(claim.converted)await runnerLease(env,runId,'release',null,epoch).catch(()=>null);return finish('failed',{code:'storage_error'});}
 // AIR-575 / ADR 0190: the preparation does not pass the route exit that records a `prediction_catalog_held` refusal, so the same neutral skipped Event is recorded here, from the same answer.
 await recordCatalogHeldStart(env,{body:payload.body,requestId,response}).catch(()=>null);
 const data=await response.clone().json().catch(()=>null);
 if(data?.status==='running')return finish('ready',{epoch});
 if(data?.code==='start_claim_lost')return finish('failed',{code:'start_claim_lost'});
 if(data?.code==='start_storage_error')return finish('failed',{code:'storage_error'});
 return finish('refused',{code:SAFE_LOG_ID.test(String(data?.code||data?.status))?String(data?.code||data?.status):'refused',reason:SAFE_LOG_ID.test(String(data?.reason))?data.reason:null});
}
async function runPredictionStartWorkflow(env,payload,step){
 return step.do('prepare',{retries:{limit:0,delay:'1 second',backoff:'constant'},timeout:'4 minutes'},()=>timedBatchStep(env,'batch_prepare',{runId:payload?.runId},payload?.requestId,timed=>predictionStartPrepare(timed,payload)));
}
// ADR 0195. The scheduled start of one of the four standing Tasks. It reuses the claim, the early lease and the join of ADR 0188, with the Task label as the correlation instead of a per-invocation key:
//  - another label (or a run without one) holds a live lease: `already_running`, nothing assigned;
//  - the same label holds it with the same start arguments: the SAME stored manifest (also after the first client submit, while that lease lives), or `start_pending` while the first start still prepares it;
//  - the same label with other start arguments: an explicit `task_args_mismatch`, not a foreign owner;
//  - no live lease (released or expired): a new run, never the old one.
async function taskStart(env,clean,requestId,tally){
 const taskId=clean.taskId,keyHash=await taskKeyHashOf(taskId),argsHash=await contentHash(startArgsOf(clean));
 const runId=crypto.randomUUID();
 forgetAuthority(env);
 const taken=await timedStage(env,'start_claim',()=>atStage('start_claim',()=>runnerLease(env,runId,'acquire',{keyHash,argsHash,taskId})));
 if(taken.status!=='owned'){
  const live=await loadJSON(env,RUNNER_LEASE_KEY);
  if(live?.runId&&Number(live.expiresAt)>Date.now()&&live.taskId===taskId){
   tally.taskRepeat=1;
   if(live.argsHash!==argsHash){tally.keyArgsMismatch=1;return json({status:'blocked',reason:'task_args_mismatch',code:'task_args_mismatch',runId:live.runId,epoch:live.epoch??null,...scheduledRunFields()},409);}
   return batchJoin(env,live,tally,{keyHash,argsHash,taskId},async()=>(await batchTurnedAway(env,clean,tally,requestId))||batchBlocked('start_owner_lost',{runId:live.runId}),clean.answer==='envelope');
  }
  return (await batchTurnedAway(env,clean,tally,requestId))||json(leaseRefusalAnswer(taken));
 }
 tally.keyed=1;
 const claim={runId,epoch:taken.epoch,keyHash,argsHash,lease:taken,converted:false};
 try{return await batchStartCore(env,clean,requestId,tally,claim);}
 catch(error){if(claim.converted)await runnerLease(env,runId,'release').catch(()=>null);throw error;}
 finally{if(!claim.converted)await runnerLease(env,runId,'release').catch(()=>null);}
}
async function batchStartWork(env,body,requestId,tally){
 const bad=validateBatchStartBody(body);if(bad)return bad;
 const notD1=await batchRequiresD1(env);if(notD1)return notD1;
 if(body.taskId!==undefined&&body.invocationKey===undefined){
  // A dry run reads and writes nothing and never claims: the label is not used. A real start by a Task takes the owner-labelled path.
  if(body.dryRun===true){const {taskId,...plain}=body;void taskId;return batchStartCore(env,plain,requestId,tally,null);}
  return taskStart(env,body,requestId,tally);
 }
 if(typeof body.invocationKey!=='string')return batchStartCore(env,body,requestId,tally,null);
 const {invocationKey,...clean}=body;
 if(clean.dryRun===true)return batchStartCore(env,clean,requestId,tally,null);
 const keyHash=await contentHash({purpose:'iptv-batch-start-key',key:invocationKey}),argsHash=await contentHash(startArgsOf(clean));
 if(clean.deferred===true)return deferredStart(env,clean,requestId,tally,{keyHash,argsHash});
 const runId=crypto.randomUUID();
 forgetAuthority(env);
 const taken=await timedStage(env,'start_claim',()=>atStage('start_claim',()=>runnerLease(env,runId,'acquire',{keyHash,argsHash,taskId:clean.taskId})));
 if(taken.status!=='owned'){
  const live=await loadJSON(env,RUNNER_LEASE_KEY);
  if(live?.runId&&live.expiresAt>Date.now()&&live.keyHash===keyHash){
   if(live.argsHash!==argsHash){tally.keyArgsMismatch=1;const refused=await batchTurnedAway(env,clean,tally,requestId,{reason:'key_args_mismatch'});if(refused)return refused;}
   else if(!live.clientSubmitAt)return batchJoin(env,live,tally,{keyHash,argsHash},async()=>(await batchTurnedAway(env,clean,tally,requestId))||batchBlocked('start_owner_lost',{runId:live.runId}),clean.answer==='envelope');
  }
  return (await batchTurnedAway(env,clean,tally,requestId))||json(leaseRefusalAnswer(taken));
 }
 tally.keyed=1;
 const claim={runId,epoch:taken.epoch,keyHash,argsHash,lease:taken,converted:false};
 // Every exit that did not become a run releases the claim (a release of a claim already taken over is refused by the lease's own run and epoch check).
 try{return await batchStartCore(env,clean,requestId,tally,claim);}
 catch(error){if(claim.converted)await runnerLease(env,runId,'release').catch(()=>null);throw error;}
 finally{if(!claim.converted)await runnerLease(env,runId,'release').catch(()=>null);}
}
async function batchStartCore(env,body,requestId,tally,claim){
 // The claim's check at a stage boundary: a lost claim ends the start before any side effect. AIR-588 (A1): a claim renewed less than CLAIM_READ_WINDOW_MS ago is checked by a read of the
 // lease (same owner, epoch and claim phase, not expired), not renewed; an older one is renewed as before. The claim lives START_CLAIM_TTL_MS (180 s), so a read leaves at least 150 s.
 // The window counts from the lease's own last write (the acquire, for a fresh claim); a claim whose last write is unknown (a deferred preparation picking up a receipt) is renewed at its first boundary, as before.
 if(claim&&!Number.isFinite(claim.renewedAt)){const at=Date.parse(claim.lease?.heartbeatAt||'');claim.renewedAt=Number.isFinite(at)?at:0;}
 const renewClaim=async()=>{
  if(!claim)return null;
  if(Date.now()-claim.renewedAt<CLAIM_READ_WINDOW_MS){tally.claimChecks=(tally.claimChecks||0)+1;const seen=await claimHeld(env,claim);if(seen.status==='owned'||seen.status==='busy')return null;tally.claimLost=1;return batchBlocked('start_claim_lost');}
  tally.claimRenewals=(tally.claimRenewals||0)+1;const renewed=await claimRenewed(env,claim);if(renewed.status==='owned'||renewed.status==='busy'){if(renewed.status==='owned')claim.renewedAt=Date.now();return null;}tally.claimLost=1;return batchBlocked('start_claim_lost');
 };
 const dryRun=body.dryRun===true;let pre=await timedStage(env,'preflight',()=>batchPreflight(env,body,tally));if(pre.response)return pre.response;
 {const lost=await renewClaim();if(lost)return lost;}
 if(dryRun){
  // A dry run reads and writes nothing: it never rebuilds the queue, so a queue that fails the advance gate is refused.
  if(pre.stale)return batchBlocked('queue_stale',{cause:pre.stale,dryRun:true});
  const answer=batchStartAnswer({...pre.manifest.body,...batchRealExtras(pre.selection,pre.queue,{queueRefreshed:false,queueSettled:0,dryRun:true}),runId:null,dryRun:true,...(pre.priorityDue?{priorityDue:true,priorityCause:pre.priorityCause||'programme',hotBasis:hotBasisOf(pre)}:pre.priorityDeferred?{hotBasis:hotBasisOf({...pre,priorityCause:'window_transition_deferred'})}:{})});
  if(batchBytes(answer)>BATCH_RUNNER.maxManifestBytes)return batchOverflowOf({...pre,bytes:batchBytes(answer)},{dryRun:true});
  noteStep(env,()=>({manifestFilms:pre.manifest.films,manifestBytes:batchBytes(answer)}));
  return json(answer);
 }
 // Precedence of a real start: an overlapping run first, then an idle outcome, then the size refusal. A live runner lease (an earlier v2 run, or a stored legacy v5 run still holding it) turns the attempt away with
 // `already_running` before anything else, naming the holder: an overlapping trigger never reports an independent start result, and it writes nothing to the queue, the run, the lease or
 // the films. It is recorded as a start attempt, like every start attempt.
 // A keyed start already holds the lease as its own claim, so the live-lease check would refuse it against itself.
 const turned=claim?null:await timedStage(env,'turned_away',()=>batchTurnedAway(env,body,tally,requestId));if(turned)return turned;
 // AIR-588 (A2, ADR 0204): proven ordering drift of the SAME completed generation (a changed assigned-shows signature or a reached window edge) no longer rebuilds the queue inside the start
 // while the stored queue has films to deliver and its last rebuild is younger than ORDERING_MAX_LAG_MS: the start delivers from the stored queue (the accepted lag of AIR-542) and the named
 // writer `reconcilePredictionOrdering` rebuilds it off the Task's path. Everything else is unchanged: a stale queue (advance gate), an unreadable signature, a new or carried generation,
 // films found already current or without an admission, an idle queue and an overdue queue still refresh here, or fail closed, exactly as before.
 const orderingDeferred=!pre.stale&&pre.priorityDue&&orderingDeferrable(pre);
 if(orderingDeferred){tally.orderingDeferred=1;if(pre.priorityCause==='window_transition')tally.orderingDeferredWindow=1;}
 const priorityDue=pre.priorityDue&&!orderingDeferred;
 // Nothing to deliver, or no capacity, on a current queue: the idle outcome of a start (before the size refusal, so `remainingPercent: 0` is `quota`, not a size error).
 forgetAuthority(env);
 // AIR-529: a known priority-due queue is reconciled before it can be idle (an empty or exhausted queue plus a new assignment in the same generation would otherwise answer `noop` on every start). A zero-quota start stays the
 // quota outcome and writes nothing; the next start with capacity reconciles.
 if(!pre.stale&&!(priorityDue&&!capacityExhausted(body.capacity))){const idle=await timedStage(env,'idle',()=>batchIdle(env,body,pre));if(idle)return idle;}
 // Zero writes while the manifest does not fit and the stored queue is current: no lease, run, queue, Event, diagnostics row or film write.
 if(pre.manifest&&pre.bytes>BATCH_RUNNER.maxManifestBytes)return batchOverflowOf(pre);
 // The guards a start runs before it takes the lease (as the retired v5 start did): the previous run's retries, and a held catalog.
 forgetAuthority(env);
 const unsettled=await timedStage(env,'settle_previous',()=>atStage('settle_previous',()=>settlePreviousRun(env,claim?claim.lease.recoveredRunId||null:null)));if(unsettled)return unsettled;
 const held=await timedStage(env,'catalog_gate',()=>atStage('catalog_gate',()=>catalogHeldCause(env)));if(held)return catalogHeldResponse(held);
 let queueRefreshed=false,queueSettled=0;
 if(pre.stale||priorityDue||pre.selection.skipped.missingAdmission.length||pre.selection.skipped.alreadyCurrent.length){
  forgetAuthority(env);
  // A deferred ordering drift is not forced into the rebuild here: only the settlement of the films the preflight found current or without an admission runs.
  try{const refreshed=await timedStage(env,'queue_refresh',()=>atStage('queue_refresh',()=>batchRefreshQueue(env,body,{...pre,priorityDue},tally)));queueRefreshed=true;queueSettled=refreshed.settled;}
  catch(error){if(CATALOG_HELD_CODES.includes(error?.code))return catalogHeldResponse(error.code);throw error;}
  // The preflight is repeated on the refreshed queue and is the baseline from here on. An overflow now has the refresh as its only effect.
  pre=await timedStage(env,'preflight_refreshed',()=>batchPreflight(env,body,tally));if(pre.response)return pre.response;
  // AIR-542: one rebuild per start. A priority that moved again during it (a Discovery assignment landing mid-rebuild) is a lag the next start repairs, never a refusal or a second rebuild.
  // An unreadable signature is not drift: hot outstanding cannot be verified at all, so no cold manifest is delivered (the next start retries the read).
  if(pre.stale||pre.priorityCause==='shows_signature_unreadable')return batchBlocked('queue_changed',{queueRefreshed:true,cause:pre.stale?'stale':'priority'});
  if(pre.priorityDue)tally.priorityLagAccepted=1;
  if(pre.bytes>BATCH_RUNNER.maxManifestBytes)return batchOverflowOf(pre,{queueRefreshed:true,...(queueSettled?{queueSettled}:{})});
  {const lost=await renewClaim();if(lost)return lost;}
 }
 // After the refresh the baseline can be idle too (the queue was stale, or every selected film was already current).
 {const idle=await timedStage(env,'idle',()=>batchIdle(env,body,pre));if(idle)return idle;}
 const runId=claim?claim.runId:crypto.randomUUID(),attemptAt=new Date().toISOString();
 const attempt={runId,createdAt:attemptAt,diagnosticStartedAt:attemptAt,trigger:body.trigger==='scheduled'?'scheduled':'manual',status:'starting',selectedIds:[],results:{},failures:{}};
 forgetAuthority(env);
 let lease=claim?claim.lease:await timedStage(env,'runner_lease',()=>atStage('runner_lease',()=>runnerLease(env,runId,'acquire')));
 if(lease.status!=='owned'){
  // Not a refusal of the manifest: the attempt is recorded as every start attempt is. A competing start that won the lease after the early check is counted like the early refusal; the holder's age is known only when the answer carries its expiry (a lost compare-and-swap does not).
  if(lease.status==='already_running'){tally.leaseRefused=1;tally.leaseRefusedAtAcquire=1;{const age=leaseAgeMs(lease);if(Number.isFinite(age))tally.liveLeaseAgeMs=Math.max(0,age);}}
  attempt.status='completed';attempt.completedAt=new Date().toISOString();attempt.stopReason=lease.status==='already_running'?null:lease.status;
  await diagnosticCheckpoint(env,attempt,{startResult:'already_running'});
  // Only a refusal the lease itself answers `already_running` is a skipped start; any other lease status keeps its own answer and writes no Event.
  if(lease.status==='already_running')await recordSkippedStart(env,{requestId,body,holder:lease});
  return json(leaseRefusalAnswer(lease));
 }
 // Revalidation, before a run, an Event or a diagnostics row exists: the queue's own generation must be the baseline's, and the selection and the manifest the same. Only the lease
 // acquire and release may have happened if it does not hold.
 let answer;
 try{
  forgetAuthority(env);
  {const lost=await renewClaim();if(lost)return lost;}
  const again=await timedStage(env,'preflight_lease',()=>batchPreflight(env,body,tally));
  if(again.response){await runnerLease(env,runId,'release',null,claim?claim.epoch:null);return again.response;}
  // AIR-542: `stale`, an unreadable signature, a revision or manifest change not proven to be a re-rank (priorityOnlyRebaseCause), and any such change that coexists with a genuine
  // difference keep the refusal. Priority drift on its own (the manifest and revision unchanged) just continues. A proven re-rank rebases once onto `again`, taken under the lease.
  const moved=again.revision!==pre.revision||again.manifest.hash!==pre.manifest.hash;
  const unsafe=again.stale?'stale':again.priorityCause==='shows_signature_unreadable'?'priority':moved?await priorityOnlyRebaseCause(env,pre,again):null;
  if(unsafe){await runnerLease(env,runId,'release',null,claim?claim.epoch:null);return batchBlocked('queue_changed',{cause:unsafe==='queue'||(unsafe==='manifest'&&again.revision!==pre.revision)?'revision':unsafe,...(queueRefreshed?{queueRefreshed:true}:{})});}
  if(again.priorityDue)tally.priorityLagAccepted=1;
  if(moved)tally.priorityRebased=1;
  // The claim becomes the run's lease under the same epoch here, so the frozen answer, its size check and the stored copy all carry the real runner-lease expiry (RUNNER_LEASE_TTL, ADR 0188). A claim that was taken over ends the start with nothing written.
  if(claim){
   let converted=null;
   for(let attempt=1;attempt<=3;attempt++){converted=await timedStage(env,'claim_convert',()=>claimConverted(env,claim));if(converted.status!=='busy')break;}
   if(converted.status==='busy')return batchBlocked('start_claim_contended');
   if(converted.status!=='owned'){tally.claimLost=1;return batchBlocked('start_claim_lost');}
   claim.converted=true;
   if(converted.value)claim.lease={...claim.lease,...converted.value,status:'owned'};
   lease=claim.lease;
  }
  const exact=await buildBatchManifest(env,{profile:again.profile,items:again.selection.items,runId,lease});
  answer=batchStartAnswer({...exact.body,...batchRealExtras(again.selection,again.queue,{queueRefreshed,queueSettled,dryRun:false})});
  if(batchBytes(answer)>BATCH_RUNNER.maxManifestBytes){await runnerLease(env,runId,'release',null,claim?claim.epoch:null);return batchOverflow({...exact,bytes:batchBytes(answer)},{queueRefreshed,...(queueSettled?{queueSettled}:{})});}
  pre={...again,manifest:exact,answer};
 }catch(error){await runnerLease(env,runId,'release',null,claim?claim.epoch:null);if(CATALOG_HELD_CODES.includes(error?.code))return catalogHeldResponse(error.code);throw error;}
 return timedStage(env,'persist',()=>batchPersistRun(env,{body,requestId,pre,lease,runId,answer,attempt,claim}));
}
// After the lease is held and the snapshot revalidated: this run's diagnostics row, pending Events, recovery of the one previous lease holder, and the run itself. Historic diagnostic settlement is complete, not start.
async function batchPersistRun(env,{body,requestId,pre,lease,runId,answer,attempt,claim=null}){
 const claimed=!!claim;
 const {profile,report,queue,selection}=pre,plan=adaptivePredictionBatch(queue,body.capacity);
 // ADR 0188. A claimed start holds one internal gate token for the whole persist. Every D1-routed authoritative write (the previous run's recovery, the run record, `latest-run`, the queue and progress
 // record, the staged drain) carries the commit guard, which the same batch checks against the lease's runId, epoch and gate token, so a handler that lost the lease commits nothing, atomically. The
 // R2 objects (diagnostics row, sources, manifest) are keyed by this runId and written only after a held-gate check; the window between that check and the put is not atomic, and an object written in it
 // is inert: no lease, run record, `latest-run` or Event refers to it. A superseded handler writes no stop Event and no step (`observedPrediction` fence) and answers `start_claim_lost`.
 const token=claimed?crypto.randomUUID():null;
 const superseded=()=>json({status:'blocked',reason:'start_claim_lost',code:'start_claim_lost',runId,...scheduledRunFields()},409);
 const storageError=()=>json({status:'blocked',reason:'storage_error',error:'storage_error',code:'start_storage_error',runId,recoverable:true,...scheduledRunFields()},502);
 // The converted lease is live (15 minutes) from here on, so every exit before `observedPrediction` takes over releases it, fenced by the run id: still ours -> a bounded recoverable error,
 // superseded -> the other holder is left untouched. Nothing here goes through the legacy stop recorder.
 const leaveOwned=async error=>{
  if(error)logPredictionFailure('start',error,requestId,runId);
  let mine=true;try{const current=await loadJSON(env,RUNNER_LEASE_KEY);mine=current?.runId===runId&&Number(current.expiresAt)>Date.now();}catch{mine=true;}
  await runnerLease(env,runId,'release',null,claimed?lease.epoch:null).catch(()=>null);
  return mine?storageError():superseded();
 };
 if(claimed){
  let gated;try{gated=await batchGateSet(env,runId,lease.epoch,token,requestId,'start-persist',true);}catch(error){return leaveOwned(error);}
  if(gated.status==='busy')return leaveOwned(null);
  if(gated.status!=='owned')return superseded();
 }
 const wenv=claimed?{...env,[BATCH_COMMIT_GUARD]:{runId,epoch:lease.epoch,token}}:env,gateCtx={run:{runId},epoch:lease.epoch,token,guarded:wenv};
 const fence=work=>claimed?batchGuardedCommit(env,gateCtx,work):work();
 const renewGate=async()=>{if(claimed){const renewed=await batchGateRenew(env,runId,lease.epoch,token);return renewed.status==='owned'||renewed.status==='busy';}return true;};
 // Every check is also a renewal of the 60 s gate (and the lease), so a long persist never loses its own gate by the clock; a gate that is gone or held by another token is a loss.
 // A claimed start (deferred preparation and, since AIR-588, the synchronous labelled or keyed start) checks with a cheap read of the gate while it is young (the gate lives 60 s) and renews once it
 // is older than GATE_READ_WINDOW_MS (20 s), so it does not pay a lease write per check.
 let gateRenewedAt=Date.now();
 const held=async()=>{
  if(!claimed)return true;
  // AIR-588 (A1): the synchronous claimed start (a Task's labelled or keyed start) checks a young gate the same way, so a persist no longer pays a lease write and its R2 mirror per check.
  if(Date.now()-gateRenewedAt<GATE_READ_WINDOW_MS){const state=await batchGateHeld(env,gateCtx);if(state==='held')return true;if(state!=='gate_lost')return false;}
  const ok=await renewGate();if(ok)gateRenewedAt=Date.now();return ok;
 };
 const clearGate=async()=>{if(claimed){try{await batchGateClear(env,runId,lease.epoch,token);}catch{/* the gate expires by itself */}}};
 const response=await observedPrediction(env,{...body,runId,diagnosticRunId:runId,protocol:BATCH_PROTOCOL},async()=>{
  if(!await held())return superseded();
  attempt.leaseAcquiredAt=lease.heartbeatAt;attempt.lastHeartbeatAt=lease.heartbeatAt;
  const previousRun=lease.recoveredRunId?await checkedRun(env,lease.recoveredRunId):null;
  attempt.startResult=previousRun&&['running','interrupted'].includes(previousRun.status)?'recovered_stale_lease':'running';
  await diagnosticCheckpoint(env,attempt,{state:'running',startResult:attempt.startResult});
  try{
   const result=await atStage('writer_lease',()=>predictionWriter(env,async owned=>{
    await timedStage(owned,'event_delivery',()=>deliverPendingEvents(owned));
    const previous=await loadJSON(env,ENRICHMENT_KEY+'latest-run.json'),recovered=lease.recoveredRunId?await checkedRun(env,lease.recoveredRunId):previous?.status==='running'?previous:null;
    if(recovered&&['running','interrupted'].includes(recovered.status)){recovered.status='interrupted';recovered.recoverable=true;recovered.reason='lease_expired';recovered.stopReason='lease_expired';recovered.completedAt=new Date().toISOString();recovered.recoveredByRunId=runId;if(!await held())return superseded();{const aux=await auxAuthority(env);await fence(()=>saveJSON(aux?{...wenv,[COMMIT_EXTRA_KEY]:{runId:recovered.runId,pre:[PredictionAux.runNotSupersededGuard(recovered.runId)],statements:[]}}:wenv,runKey(recovered.runId),recovered));}await diagnosticCheckpoint(env,recovered);}
    const manifest=pre.manifest,selected=selection.items,createdAt=new Date().toISOString();
    const stagedDoc=await loadJSON(env,BATCH_STAGE_KEY);
    const stagedItems=Array.isArray(stagedDoc?.items)?stagedDoc.items:[];
    const newIds=selected.map(item=>item.filmId);
    const selectionKind=Object.fromEntries(selected.map(item=>[item.filmId,item.lane]));
    const baseline=Object.fromEntries(selected.map(item=>[item.filmId,item.state.predictions?.current?.generatedAt||null]));
    const run={runId,pipelineVersion:PREDICTION_PIPELINE_VERSION,protocol:BATCH_PROTOCOL,epoch:lease.epoch??null,manifestHash:manifest.hash,manifestBytes:batchBytes(answer),manifestSize:selection.manifestSize??BATCH_RUNNER.maxManifestFilms,status:'running',mode:'queued',trigger:body.trigger==='scheduled'?'scheduled':'manual',createdAt,diagnosticStartedAt:attempt.diagnosticStartedAt,leaseAcquiredAt:lease.heartbeatAt||createdAt,startResult:attempt.startResult||(recovered?.recoverable?'recovered_stale_lease':'running'),lastActivityAt:createdAt,deadlineAt:null,lastHeartbeatAt:createdAt,batchCount:1,capacity:body.capacity||{},sourceProgrammeRunId:report.runId,tasteProfileVersion:profile.version,tasteProfileHash:profile.profileHash,fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,fingerprintPromptVersion:FINGERPRINT_PROMPT_VERSION,predictionPromptVersion:PREDICTION_PROMPT_VERSION,fingerprintRegistryDigest:manifest.body.contract.registryDigest,eligibleCount:(queue.hotCount||0)+(queue.coldCount||0),batchSize:selected.length,adaptivePlan:plan,selectedIds:[...newIds],batchIds:[...newIds],selectionKind,baseline,failures:{},results:{}};
    if(claimed){run.keyHash=claim.keyHash;run.argsHash=claim.argsHash;}
    if(isTaskId(body.taskId))run.taskId=body.taskId;
    if(!await held())return superseded();
    const sources=Object.fromEntries(selected.map(item=>[item.filmId,modelMetadata(item.film)]));
    // ADR 0194 decision 4: with the sources in D1 the first revision, its head and the run's binding (`sourceRevision`, `sourceHash`) commit in the run's OWN batch, under the runner-lease fence; a crash
    // between "source" and "run" cannot leave one without the other. The legacy path writes the R2 source object and then the run, as before.
    const auxSource=await auxAuthority(env);
    if(auxSource){
     const plan=await PredictionAux.planSource(auxDb(env),auxSource,run.runId,sources,{create:true});
     run.sourceRevision=plan.revision;run.sourceHash=plan.hash;
     const fenced=PredictionAux.guardsFor(auxSource,{runId:run.runId,epoch:lease.epoch,token:claimed?token:null},{fence:'run'});
     await atStage('run_save',()=>fence(()=>savePredictionRun({...wenv,[COMMIT_EXTRA_KEY]:{runId:run.runId,statements:[...fenced,...plan.statements]}},run)));
    }else{
    await saveJSON({...env,[BATCH_COMMIT_GUARD]:{runId:run.runId,epoch:lease.epoch,token:claimed?token:null,create:true}},ENRICHMENT_KEY+'sources/'+run.runId+'.json',sources);
    await atStage('run_save',()=>fence(()=>savePredictionRun(wenv,run)));
    }
    await atStage('runner_started',()=>fence(()=>runnerStarted(wenv,run,queue,null)));
    let drained={committed:[],dropped:[]};
    if(!await held())return superseded();
    if(stagedItems.length){
     // A claimed start drains under its own gate (the same token, so the drain's commits carry the same guard); a keyless start takes a drain gate as before.
     const drainToken=claimed?token:crypto.randomUUID();
     const gated=claimed?{status:'owned'}:await batchGateSet(env,run.runId,run.epoch,drainToken,requestId,'stage-drain',true);
     if(gated.status==='owned'){
      try{drained=await drainBatchStage(env,run,{token:drainToken,requestId,epoch:run.epoch},profile);}
      finally{if(!claimed){try{await batchGateClear(env,run.runId,run.epoch,drainToken);}catch{/* gate expires */}}}
     }
    }
    const droppedIds=drained.dropped.map(row=>typeof row==='string'?row:row.filmId);
    const startAnswer=drained.committed.length||droppedIds.length?{...answer,drained:{committed:drained.committed.length,dropped:droppedIds.length,committedIds:drained.committed,droppedIds,droppedReasons:drained.dropped.filter(row=>row&&typeof row==='object')}}:answer;
    if(!await held())return superseded();
    const auxMarker=claim?.deferred?await auxAuthority(env):null;
    if(auxMarker){
     // ADR 0194 decision 5: with the auxiliary state in D1 the manifest rows and the readiness edit are ONE guarded batch, so `ready` is never declared before a durable, readable manifest.
     const ready=await timedStage(env,'manifest_ready',()=>auxStartReadyWithManifest(env,auxMarker,claim,token,startAnswer));
     if(ready.status!=='owned')return ready.status==='lease_lost'||ready.status==='gate_lost'?superseded():storageError();
    }else{
    await timedStage(env,'manifest_ready',()=>saveJSON({...env,[BATCH_COMMIT_GUARD]:{runId:run.runId,epoch:lease.epoch,token:claimed?token:null}},ENRICHMENT_KEY+'batch-manifest/'+run.runId+'.json',startAnswer));
    if(claim?.deferred){
     // The readiness boundary: one owner-fenced edit ends the preparation (gate and `prep` removed, short expiry kept unless the client already renewed). It is the last write; the manifest is not served
     // before it. If it does not happen the start fails typed and the lease is released, never left on a longer TTL.
     const ready=await startReady(env,claim,token);
     if(ready.status!=='owned')return ready.status==='lease_lost'||ready.status==='gate_lost'?superseded():storageError();
    }else await clearGate();
    }
    const delivered=body.answer==='envelope'?batchStartEnvelope(startAnswer):startAnswer;
    noteStep(env,()=>({manifestFilms:manifest.films,manifestBytes:batchBytes(startAnswer),answerBytes:batchBytes(delivered),...(delivered!==startAnswer?{envelopeAnswer:1}:{}),drainedCommitted:drained.committed.length,drainedDropped:drained.dropped.length}));
    return json(delivered);
   }));
   if(result.status>=400)await runnerLease(env,runId,'release',null,claimed?lease.epoch:null);
   return result;
  }catch(error){
   if(error instanceof BatchGateLost)return superseded();
   // Ownership is decided before the release: after a release the same check would always say "lost".
   const stillOwner=claimed?await held().catch(()=>false):true;
   await runnerLease(env,runId,'release',null,claimed?lease.epoch:null);
   if(!stillOwner)return superseded();
   if(CATALOG_HELD_CODES.includes(error?.code)&&error?.stage==='queue_refresh'){logPredictionFailure('start',error,requestId,runId);return catalogHeldResponse(error.code);}
   if(claimed){logPredictionFailure('start',error,requestId,runId);return json({status:'blocked',reason:'storage_error',error:'storage_error',code:'start_storage_error',runId,recoverable:true,...scheduledRunFields()},502);}
   throw error;
  }
 },'start',requestId,claimed?{fence:held,epoch:lease.epoch}:{});
 const data=await response.clone().json();
 if(data.code==='start_claim_lost'||data.code==='start_storage_error'){if(!claim?.deferred)await clearGate();return response;}
 if(data.status!=='running'){attempt.status=data.status==='already_running'?'completed':data.status==='noop'?'idle':'blocked';attempt.completedAt=new Date().toISOString();attempt.stopReason=data.stopReason||data.reason||(data.error?'storage_error':null);await diagnosticCheckpoint(env,attempt,{startResult:['already_running','blocked','noop'].includes(data.status)?data.status:'error',leaseAcquiredAt:attempt.leaseAcquiredAt||null,lastHeartbeatAt:attempt.lastHeartbeatAt||null});}
 return response;
}
// ---- Batch runner v2: batch_submit (ADR 0122). One call settles 1 to 10 films of a run's manifest; the validation is made once, here, per film. ----
const BATCH_GATE_TTL_MS=60000;
// AIR-588 (A1): how long after its last renewal a held persist gate is checked by a read instead of renewed (the gate lives BATCH_GATE_TTL_MS, so a check leaves at least 40 s).
const GATE_READ_WINDOW_MS=20000;
const BATCH_COMMIT_GUARD=Symbol.for('iptv.prediction.commitGuard');
const COMMIT_EXTRA_KEY=Symbol.for('iptv.prediction.commitExtra');
const BATCH_MODEL_FIELDS=['predictedRating','probability4Plus','confidence','matchSignals','mainRisk','moodLabels'];
const BATCH_ITEM_KEYS=['filmId','fingerprint','prediction','failure','inputHash','assessment'];
// Undeclared item keys are named with the closed-contract code; only a sanitised, truncated key reaches the path, never a value.
function unknownItemKeyIssues(items,allowed){const issues=[];if(Array.isArray(items))items.forEach((item,i)=>{if(isObject(item))for(const key of Object.keys(item))if(!allowed.includes(key)&&issues.length<MAX_ISSUES)issues.push({path:'items['+i+'].'+key.replace(/[^A-Za-z0-9_]/g,'_').slice(0,40),code:'unknown_field'});});return issues;}
// AIR-472: the optional, caller-supplied account of why a film is reported as failed. Closed vocabulary, bounded, never free text. It is a client claim (reportedBy=caller), not Worker telemetry:
// the Worker did not necessarily see the preflight the caller echoes, and it never validates a candidate through this branch.
const CALLER_FAILURE_REASONS=['preflight_validation_failed','insufficient_evidence','json_unparseable','request_too_large'];
const CALLER_ASSESSMENT_PATHS=['assessment','assessment.assessmentVersion','assessment.ratingBasis','assessment.probability4PlusBasis','assessment.tasteSignals','assessment.tasteSignals.signal','assessment.tasteSignals.anchor','assessment.tasteSignals.direction','assessment.risks','assessment.risks.risk','assessment.risks.severity','assessment.uncertainties','assessment.research','assessment.research.status','assessment.research.attempts','assessment.research.attempts.ref','assessment.research.attempts.outcome','assessment.research.attempts.note','assessment.sources','assessment.sources.kind','assessment.sources.ref','assessment.sources.access','assessment.sources.usedFor','assessment.conflicts','assessment.conflicts.topic','assessment.conflicts.handling','assessment.conflicts.positions','assessment.conflicts.positions.source','assessment.conflicts.positions.author','assessment.conflicts.positions.stance','assessment.model','assessment.model.status','assessment.model.id','assessment.model.version','assessment.model.effort'];
let callerFailurePaths=null;
// The paths the Worker's own validators can report, built from the contract constants: a path outside this set is not a preflight path and is never stored or shown.
function callerFailurePathAllowed(path){
 if(typeof path!=='string')return false;
 if(!callerFailurePaths){
  const set=new Set(['fingerprint','prediction','fingerprint.evidence','fingerprint.evidence.plotMechanics','fingerprint.evidence.execution',...CALLER_ASSESSMENT_PATHS]);
  for(const key of Object.keys(FINGERPRINT_RULES))set.add('fingerprint.'+key);
  for(const key of Object.keys(EXECUTION)){set.add('fingerprint.execution.'+key);set.add('fingerprint.evidence.execution.'+key);}
  for(const key of MECHANICS)set.add('fingerprint.evidence.plotMechanics.'+key);
  for(const key of BATCH_MODEL_FIELDS)set.add('prediction.'+key);
  callerFailurePaths=set;
 }
 return callerFailurePaths.has(path);
}
function callerFailureIssues(failure){
 if(!isObject(failure))return [{path:'failure',code:'invalid_type'}];
 const issues=[];
 for(const key of Object.keys(failure))if(!['kind','reason','preflight'].includes(key)&&issues.length<MAX_ISSUES)issues.push({path:'failure.'+key.replace(/[^A-Za-z0-9_]/g,'_').slice(0,40),code:'unknown_field'});
 if(failure.reason===undefined)issues.push({path:'failure.reason',code:'required'});
 else if(!CALLER_FAILURE_REASONS.includes(failure.reason))issues.push({path:'failure.reason',code:typeof failure.reason==='string'?'invalid_enum':'invalid_type'});
 if(failure.preflight!==undefined){
  const p=failure.preflight;
  if(!isObject(p))issues.push({path:'failure.preflight',code:'invalid_type'});
  else{
   for(const key of Object.keys(p))if(key!=='issues'&&issues.length<MAX_ISSUES)issues.push({path:'failure.preflight.'+key.replace(/[^A-Za-z0-9_]/g,'_').slice(0,40),code:'unknown_field'});
   if(!Array.isArray(p.issues))issues.push({path:'failure.preflight.issues',code:p.issues===undefined?'required':'invalid_type'});
   else if(p.issues.length>MAX_ISSUES)issues.push({path:'failure.preflight.issues',code:'too_many'});
   else p.issues.forEach((issue,i)=>{
    if(!isObject(issue)||Object.keys(issue).some(key=>key!=='path'&&key!=='code')){issues.push({path:'failure.preflight.issues['+i+']',code:'invalid_type'});return;}
    if(!callerFailurePathAllowed(issue.path))issues.push({path:'failure.preflight.issues['+i+'].path',code:'invalid_ref'});
    if(!ISSUE_CODES.includes(issue.code))issues.push({path:'failure.preflight.issues['+i+'].code',code:'invalid_enum'});
   });
  }
 }
 return issues.slice(0,MAX_ISSUES);
}
// Canonical form of a valid claim: issues sorted by path then code and deduplicated, so equal claims hash and compare equal. Null only for a historical kind-only item (new submits require reason).
function callerFailureClaim(failure){
 if(!isObject(failure)||failure.reason===undefined&&failure.preflight===undefined)return null;
 const list=Array.isArray(failure.preflight?.issues)?failure.preflight.issues:[],seen=new Set(),issues=[];
 for(const issue of [...list].sort((a,b)=>String(a.path).localeCompare(String(b.path))||String(a.code).localeCompare(String(b.code)))){const key=issue.path+' '+issue.code;if(!seen.has(key)){seen.add(key);issues.push({path:issue.path,code:issue.code});}}
 return {...(failure.reason!==undefined?{reason:failure.reason}:{}),...(failure.preflight!==undefined?{preflightIssues:issues}:{})};
}
// The failure part of an item digest: the bare kind string for the legacy shape (digests stay byte-identical), kind plus the canonical claim otherwise.
function batchFailureDigestPart(failure){
 if(!isObject(failure))return null;
 const claim=callerFailureClaim(failure);
 return claim?{kind:String(failure.kind||''),...claim}:String(failure.kind||'');
}
const batchPick=(value,keys)=>Object.fromEntries(keys.filter(key=>isObject(value)&&value[key]!==undefined).map(key=>[key,value[key]]));
// One digest per item over one tuple of reproducible projections (ADR 0122 decision 6): the model-supplied prediction fields (not the Worker's), the fingerprint's content hash
// (the same one the stored fingerprint carries) and the failure kind. It is recomputable from a committed film, so a replay after a crash is recognized without a receipt store.
async function batchItemDigest(id,item){
 return contentHash({filmId:id,fingerprint:isObject(item?.fingerprint)?await contentHash({...item.fingerprint,filmId:id}):null,prediction:isObject(item?.prediction)?batchPick(item.prediction,BATCH_MODEL_FIELDS):null,failure:batchFailureDigestPart(item?.failure),...(item?.assessment!==undefined?{assessmentSha256:await assessmentSha256(item.assessment)}:{})});
}
function validateBatchSubmitBody(body){
 if(!isObject(body)||!isText(body.runId,100)||!Number.isInteger(body.epoch)||body.epoch<1)return json({error:'Invalid runId or epoch'},400);
 if(body.useHeld===true){
  if(body.items!==undefined)return json({error:'useHeld cannot be combined with items'},400);
  if(body.dryRun===true)return json({error:'useHeld is not accepted with dryRun'},400);
  return null;
 }
 if(!Array.isArray(body.items)||!body.items.length||body.items.length>BATCH_RUNNER.submitMaxItems)return json({error:'Expected 1–'+BATCH_RUNNER.submitMaxItems+' items'},400);
 {const unknown=unknownItemKeyIssues(body.items,BATCH_ITEM_KEYS);if(unknown.length)return json({error:'Invalid item',issues:unknown},400);}
 for(const item of body.items)if(!isObject(item)||!isText(item.filmId,100)||item.fingerprint!==undefined&&!isObject(item.fingerprint)||item.prediction!==undefined&&!isObject(item.prediction)||item.failure!==undefined&&!isObject(item.failure)||item.assessment!==undefined&&!isObject(item.assessment))return json({error:'Invalid item'},400);
 {const claimIssues=[];body.items.forEach((item,i)=>{if(item.failure!==undefined)for(const issue of callerFailureIssues(item.failure))if(claimIssues.length<MAX_ISSUES)claimIssues.push({path:'items['+i+'].'+issue.path,code:issue.code});});if(claimIssues.length)return json({error:'Invalid item',issues:claimIssues},400);}
 if(new Set(body.items.map(item=>String(item.filmId))).size!==body.items.length)return json({error:'Duplicate filmId'},400);
 if(body.dryRun!==true&&body.items.some(item=>item.inputHash!==undefined))return json({error:'inputHash is accepted only with dryRun'},400);
 if(body.items.some(item=>item.inputHash!==undefined&&!/^[0-9a-f]{24}$/.test(String(item.inputHash))))return json({error:'Invalid inputHash'},400);
 if(body.dryRun!==undefined&&typeof body.dryRun!=='boolean')return json({error:'Invalid dryRun'},400);
 if(body.manifestHash!==undefined&&!/^[0-9a-f]{64}$/.test(String(body.manifestHash)))return json({error:'Invalid manifestHash'},400);
 if(body.contract!==undefined&&!isObject(body.contract))return json({error:'Invalid contract'},400);
 if(body.dryRun!==true&&(body.manifestHash!==undefined||body.contract!==undefined))return json({error:'manifestHash and contract are accepted only with dryRun'},400);
 return null;
}
// Edits the runner lease value under its own compare-and-swap. The caller's `edit(old,now)` returns {value} to write or {refuse} to answer without writing. The lease must still name this
// run and epoch and be alive; a lost swap is read again (RUNNER_LEASE_ATTEMPTS) and ends as `busy / lease_contention` while the run still owns the lease, never as `lease_lost`.
async function runnerLeaseEdit(env,runId,epoch,edit){
 for(let attempt=1;;attempt++){
  const head=typeof PredictionD1==='undefined'?null:await PredictionD1.openLease(env,RUNNER_LEASE_KEY),object=head?head.object:await env.BUCKET.get(RUNNER_LEASE_KEY),old=head?head.value:(object?await object.json():null),now=Date.now();
  if(!old||old.runId!==runId||old.expiresAt<=now)return {status:'lease_lost',runId:old?.runId||null};
  if(previousEpochOf(old)!==epoch)return {status:'lease_lost',runId:old.runId,reason:'epoch'};
  const decided=edit(old,now);if(decided.refuse)return decided.refuse;
  const saved=head?await PredictionD1.writeLease(env,head,decided.value):await env.BUCKET.put(RUNNER_LEASE_KEY,JSON.stringify(decided.value),{onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});
  if(saved===null){
   if(attempt<RUNNER_LEASE_ATTEMPTS)continue;
   const current=await loadJSON(env,RUNNER_LEASE_KEY);
   if(current?.runId===runId&&current.expiresAt>Date.now()&&previousEpochOf(current)===epoch)return {status:'busy',reason:'lease_contention',runId};
   return {status:'lease_lost',runId:current?.runId||null};
  }
  return {status:'owned',value:decided.value};
 }
}
// The gate is owned by a **token the Worker generates for each call**, never by the caller-supplied X-Request-Id: the id is kept only for the logs. While any gate is live, no
// second acquisition succeeds, whatever its id or body; renew, clear and the D1 commit guard all compare the token, so a superseded handler can neither commit nor clear the
// gate of its replacement.
const batchGateSet=(env,runId,epoch,token,requestId,bodyHash,internal=false)=>runnerLeaseEdit(env,runId,epoch,(old,now)=>{
 const gate=old.submitGate;
 if(gate&&gate.expiresAt>now)return {refuse:{status:'in_flight',retryAfterMs:Math.max(1000,gate.expiresAt-now)}};
 const at=new Date(now).toISOString();
 // ADR 0188: the first genuine client submit closes the join window, once and for good. Heartbeat, renewals and the internal staged drain never set the marker.
 return {value:{...old,...(internal||old.clientSubmitAt?{}:{clientSubmitAt:at}),heartbeatAt:at,expiresAt:now+leaseTtlOf(old),submitGate:{token,requestId:String(requestId||'').slice(0,100),bodyHash,startedAt:at,expiresAt:now+BATCH_GATE_TTL_MS}}};
});
const batchGateRenew=(env,runId,epoch,token)=>runnerLeaseEdit(env,runId,epoch,(old,now)=>{
 if(old.submitGate?.token!==token||old.submitGate.expiresAt<=now)return {refuse:{status:'gate_lost',runId}};
 return {value:{...old,heartbeatAt:new Date(now).toISOString(),expiresAt:now+leaseTtlOf(old),submitGate:{...old.submitGate,expiresAt:now+BATCH_GATE_TTL_MS}}};
});
const batchGateClear=(env,runId,epoch,token)=>runnerLeaseEdit(env,runId,epoch,(old,now)=>{
 if(old.submitGate?.token!==token)return {refuse:{status:'owned'}};
 const {submitGate,...rest}=old;
 return {value:{...rest,heartbeatAt:new Date(now).toISOString(),expiresAt:now+leaseTtlOf(old)}};
});
// The scope of the change between the run's profile and the current one, read from the current profile's own lineage (the declared impact of every link after the run's version).
// An absent link, a broken chain or an undeclared impact is `global`: nothing is kept on a guess.
function batchProfileChange(run,current){
 const lineage=Array.isArray(current?.lineage)?current.lineage:[],start=lineage.findIndex(link=>link?.version===run.tasteProfileVersion&&link?.profileHash===run.tasteProfileHash);
 let scope=start>=0?'identity':'global';
 if(start>=0)for(const link of lineage.slice(start+1)){const kind=link?.changeImpact?.scope;if(kind==='global'||!['identity','selective'].includes(kind)){scope='global';break;}if(kind==='selective')scope='selective';}
 return {changed:true,from:{version:run.tasteProfileVersion,hash:run.tasteProfileHash},to:{version:current.version,hash:current.profileHash},scope};
}
function batchCompatibilityOf(verdict){
 if(verdict?.outcome==='current'||verdict?.outcome==='compatible')return 'compatible';
 return ['profile_impacted','profile_global_change','profile_changed'].includes(verdict?.reason)?'impacted':'unknown';
}
// Does this call still hold the lease, its epoch and its gate token? `busy` (a lost compare-and-swap) still means the run owns the lease.
async function batchGateHeld(env,ctx){
 const held=await runnerLeaseEdit(env,ctx.run.runId,ctx.epoch,old=>old.submitGate?.token===ctx.token&&old.submitGate.expiresAt>Date.now()?{refuse:{status:'held'}}:{refuse:{status:'gate_lost'}});
 return held.status==='held'||held.status==='busy'?'held':held.status==='lease_lost'?'lease_lost':'gate_lost';
}
// A commit made with the guard: a lost compare-and-swap of the domain generation is retried while this call still holds the lease and its gate, otherwise the handler stops.
class BatchGateLost extends Error{constructor(status){super('batch gate lost');this.status=status;}}
async function batchGuardedCommit(env,ctx,work){
 for(let attempt=1;;attempt++){
  try{return await work();}
  catch(error){
   if(error?.code!=='prediction_domain_cas'&&error?.code!=='prediction_queue_conflict')throw error;
   const held=await batchGateHeld(env,ctx);
   if(held!=='held')throw new BatchGateLost(held);
   if(attempt>=3)throw error;
  }
 }
}
// One item. Returns {result, stop?}; the run record is changed in memory and saved by the caller after every item (guarded).
async function batchSubmitItem(env,ctx,item){
 const {run,freshness,change,source,guarded}=ctx,id=String(item.filmId);
 if(!run.selectedIds.includes(id))return {result:{filmId:id,status:'not_in_manifest'}};
 item=withDerivedSource(item,source[id]);
 run.submitted||={};
 const digest=await batchItemDigest(id,item),recorded=run.submitted[id];
 if(recorded){
  // A different payload for a film this run already settled is a conflict, a failed film included: a failure is not retried in the same run, and only the identical payload is a replay.
  if(recorded.inputDigest!==digest)return {result:{filmId:id,status:'conflict'}};
  const sent=item.assessment!==undefined,replayAssessment=recorded.assessment==='written'||recorded.assessment==='present'?'present':sent?'not_applicable':'not_sent';
  if(recorded.outcome==='validation_failure'){const failure=run.failures[id]||{};return {result:{filmId:id,status:'validation_failure',error:failure.kind||'parse_error',retryable:true,retryAt:failure.retryAt,...(failure.validation?{validation:failure.validation}:{}),assessment:sent?'not_applicable':'not_sent',replayed:true}};}
  return {result:{filmId:id,status:recorded.outcome,assessment:replayAssessment,replayed:true,...(recorded.compatibility?{compatibility:recorded.compatibility}:{})}};
 }
 let failureStage='storage_error',validationStage=null,reportedBy=null,issues=null,claimed=null,result=null;
 try{
  const state=await readFilmState(env,id);let fingerprint=state.fingerprint;const genres=source[id]?.genres,stored=state.predictions?.current;
  // The crash window: the prediction was committed by this run but its result was not recorded. The stored record carries this run id and the model fields the request carries.
  if(stored?.runId===run.runId){
   const same=await contentHash({filmId:id,fingerprint:isObject(item.fingerprint)?fingerprint?.fingerprintHash||null:null,prediction:isObject(item.prediction)?batchPick(stored,BATCH_MODEL_FIELDS):null,failure:batchFailureDigestPart(item.failure),...(item.assessment!==undefined?{assessmentSha256:await assessmentSha256(item.assessment)}:{})});
   if(same!==digest)return {result:{filmId:id,status:'conflict'}};
   // An assessment object the interrupted call did not get to write is written now; one that exists with other content is a conflict and nothing is overwritten.
   let assessmentStatus='not_sent';
   if(item.assessment!==undefined&&stored.contentSha256){try{assessmentStatus=await writePredictionAssessment(env,id,{contentSha256:stored.contentSha256,r2Key:stored.r2Key||predictionVersionKey(id,stored.contentSha256)},{recordedAt:new Date().toISOString(),runId:run.runId,trigger:stored.trigger,predictionGeneratedAt:stored.generatedAt,tasteProfile:{version:stored.tasteProfileVersion,hash:stored.tasteProfileHash},fingerprintHash:stored.fingerprintHash},item.assessment);}catch(error){if(error instanceof AssessmentConflict)return {result:{filmId:id,status:'conflict',assessment:'conflict'}};throw error;}}
   const outcome=run.baseline?.[id]?'recalculated':'created';run.results[id]=outcome;delete run.failures[id];run.submitted[id]={outcome,inputDigest:digest,assessment:assessmentStatus,committedAt:new Date().toISOString()};
   rememberBatchEventFilm(run,id,source,{group:'success',status:outcome,rating:stored?.predictedRating,source:compactEventSource(item.assessment)});
   return {result:{filmId:id,status:outcome,assessment:assessmentStatus,replayed:true},settled:true};
  }
  if(item.failure&&!freshness.state(stored,fingerprint,genres,id)){failureStage='parse_error';validationStage='caller_reported';reportedBy='caller';issues=[];claimed=callerFailureClaim(item.failure);throw new Error('Reported malformed model response');}
  const usable=f=>freshness.fingerprintUsable(f,genres,id);
  if(item.fingerprint&&!usable(fingerprint)){
   const found=fingerprintIssues(item.fingerprint,source[id]);if(found.length){failureStage='parse_error';validationStage='fingerprint_schema';reportedBy='worker';issues=found;throw new Error('Invalid fingerprint');}
   fingerprint=await batchGuardedCommit(env,ctx,()=>writeFingerprint(guarded,id,item.fingerprint,fingerprint,'generated',undefined,FINGERPRINT_PROMPT_VERSION));
  }
  if(!usable(fingerprint)){failureStage='parse_error';validationStage='fingerprint_missing';reportedBy='worker';issues=[{path:'fingerprint',code:'required'}];throw new Error('Current fingerprint required');}
  if(freshness.state(stored,fingerprint,genres,id)){
   run.results[id] ||= 'already_current';delete run.failures[id];run.submitted[id]={outcome:'already_current',inputDigest:digest,assessment:item.assessment!==undefined?'not_applicable':'not_sent',committedAt:new Date().toISOString()};result={filmId:id,status:'already_current',assessment:item.assessment!==undefined?'not_applicable':'not_sent'};
  }else{
   const found=predictionIssues(item.prediction);if(found.length){failureStage='parse_error';validationStage='prediction_schema';reportedBy='worker';issues=found;throw new Error('Invalid prediction');}
   {const foundAssessment=assessmentIssues(item.assessment,source[id]);if(foundAssessment.length){failureStage='parse_error';validationStage='assessment_schema';reportedBy='worker';issues=foundAssessment;throw new Error('Invalid assessment');}}
   const submitted=pickPrediction(item.prediction);const at=new Date().toISOString();
   // The record keeps the profile identity the model worked from: the run's, which is not the current one after a change.
   const generated={...submitted,filmId:id,generatedAt:at,tasteProfileVersion:run.tasteProfileVersion,tasteProfileHash:run.tasteProfileHash,fingerprintHash:fingerprint.fingerprintHash,fingerprintSchemaVersion:fingerprint.fingerprintSchemaVersion,fingerprintPromptVersion:fingerprint.fingerprintPromptVersion??1,predictionPromptVersion:PREDICTION_PROMPT_VERSION,runId:run.runId,trigger:run.trigger==='scheduled'?'scheduled':'manual',confidenceAssessment:assessPredictionConfidence({...fingerprint,fingerprintHash:fingerprint.fingerprintHash})};
   // The profile moved under the run: the same combined verdict (selective rule, lineage, impact features) decides, film by film. A film the change does not reach is kept; the others are
   // returned for regeneration. Neither is a failure: no retry record, no backoff, no format-error streak.
   let compatibility=null;
   if(change){
    const verdict=freshness.work(generated,fingerprint,genres);compatibility=batchCompatibilityOf(verdict);
    if(compatibility!=='compatible'){
     run.submitted[id]={outcome:'needs_regeneration',inputDigest:digest,compatibility,assessment:item.assessment!==undefined?'not_applicable':'not_sent',committedAt:new Date().toISOString()};
     return {result:{filmId:id,status:'needs_regeneration',compatibility,assessment:item.assessment!==undefined?'not_applicable':'not_sent',...(verdict?.reason?{reason:verdict.reason}:{})},regenerate:id};
    }
   }
   const old=stored,history=[...(state.predictions?.history||[])],pointer=await writePredictionVersion(env,id,generated),prediction={...generated,...pointer};
   // Order: version object, assessment object, guarded D1 commit. A failure here leaves unreferenced objects and an unchanged pointer; the same body replays.
   let assessmentStatus='not_sent';
   // A collision with an object of other content is deterministic, not a storage failure: the film is a conflict, nothing is overwritten and the pointer does not move.
   if(item.assessment!==undefined){try{assessmentStatus=await writePredictionAssessment(env,id,pointer,{recordedAt:at,runId:run.runId,trigger:generated.trigger,predictionGeneratedAt:at,tasteProfile:{version:run.tasteProfileVersion,hash:run.tasteProfileHash},fingerprintHash:fingerprint.fingerprintHash},item.assessment);}catch(error){if(error instanceof AssessmentConflict){return {result:{filmId:id,status:'conflict',assessment:'conflict'}};}throw error;}}
   if(old)history.push({...old,replacedAt:at});
   await batchGuardedCommit(env,ctx,()=>saveJSON(guarded,filmKey(id)+'predictions.json',{current:prediction,history}));
   delete run.failures[id];const outcome=old?'recalculated':'created';run.results[id]=outcome;run.submitted[id]={outcome,inputDigest:digest,assessment:assessmentStatus,...(compatibility?{compatibility}:{}),committedAt:at};
   rememberBatchEventFilm(run,id,source,{group:'success',status:outcome,rating:submitted.predictedRating,source:compactEventSource(item.assessment)});
   result={filmId:id,status:outcome,assessment:assessmentStatus,...(compatibility?{compatibility}:{})};
  }
   if(['created','recalculated'].includes(run.results[id]))run.firstSubmitAt||=new Date().toISOString();run.formatFailureStreak=0;
  return {result,settled:true};
 }catch(error){
  if(error instanceof BatchGateLost)return {result:{filmId:id,status:'blocked',reason:error.status},stop:error.status};
  const at=new Date().toISOString(),retryable=failureStage==='parse_error',previous=await loadJSON(env,predictionQueueKey),attempts=(previous?.retries?.[id]?.attempts||0)+1,retryAt=Date.now()+Math.min(6*3600000,3600000*2**(attempts-1));
  const validation=validationStage?{stage:validationStage,reportedBy,issues,...(claimed?{claimed}:{})}:null;
  if(!retryable)return {result:{filmId:id,status:'blocked',reason:'storage_error'},stop:'storage_error'};
  run.failures[id]={kind:failureStage,scope:'item',retryable:true,failedAt:at,retryAt,attempts,...(validation?{validation}:{})};run.results[id]='failed';run.retryHeal='pending';
  run.submitted[id]={outcome:'validation_failure',inputDigest:digest,committedAt:at};
  rememberBatchEventFilm(run,id,source,{group:'failure',kind:failureStage,attempts});
  if(countsTowardFormatStorm(validation)){run.formatFailureStreak=(run.formatFailureStreak||0)+1;if(run.formatFailureStreak>=5)run.systemicStopReason='format_error_storm';}
  if(validationStage){const stages=[...(run.itemValidation?.stages||[]),{stage:validationStage,reportedBy}].slice(-8);run.itemValidation={consecutive:run.formatFailureStreak||0,stages};}
  return {result:{filmId:id,status:'validation_failure',error:failureStage,retryable:true,retryAt,...(validation?{validation}:{}),assessment:item.assessment!==undefined?'not_applicable':'not_sent'},failure:id};
 }
}
// The retry record of a failed film goes to the queue at once, as in a v5 submit; a concurrent record of the same film can only raise attempts and retryAt, and the run and the answer follow it.
async function batchRecordRetry(env,run,id,result){
 const failure=run.failures[id];if(!failure)return;let record=null;
 await mutatePredictionQueue(env,queue=>{queue.retries||={};const merged=mergeRetryRecord(queue.retries[id],failure,run.runId);if(!merged||merged===queue.retries[id])return null;queue.retries[id]=record=merged;if(retryBudgetExhausted(merged))holdRetryExhaustedFilm(queue,id);return queue;},'submit_failure');
 if(record&&(record.attempts!==failure.attempts||record.retryAt!==failure.retryAt)){failure.attempts=record.attempts;failure.retryAt=record.retryAt;result.retryAt=record.retryAt;}
}
// Progress of a v2 run is ordered behind an authoritative checkpoint. The run record is saved first (guarded: gate token, epoch, lease) with the Event as `progressIntent` and the counters
// that say it is due; only then is the Event written (its id is fixed and the write is idempotent), and the intent is cleared by a second guarded save. A handler that lost its gate before
// the Event write leaves the intent for the next holder, which publishes it first, so a progress Event is never written by an unowned handler and never lost or duplicated.
async function batchPublishIntent(env,ctx){
 const run=ctx.run,intent=run.progressIntent;if(!intent)return;
 const held=await batchGateHeld(env,ctx);if(held!=='held')throw new BatchGateLost(held);
 if(!isBatchV2Run(run))await writeEvent(env,intent);
 delete run.progressIntent;
 await batchGuardedCommit(env,ctx,()=>savePredictionRun(ctx.guarded,run));
}
async function batchProgress(env,ctx,queue){
 const run=ctx.run;
 await batchPublishIntent(env,ctx);
 const event=await predictionProgressEvent(env,run,queue,false);if(!event)return;
 run.progressIntent=event;
 await batchGuardedCommit(env,ctx,()=>savePredictionRun(ctx.guarded,run));
 await batchPublishIntent(env,ctx);
}
// A v2 submit is not passed through the shared step recorder: that recorder appends diagnostics steps and, for a lost lease or a storage failure, calls the unfenced stop recorder, which writes
// the run, a stop Event, the queue's retries and `latest-run` without the gate and the epoch, on behalf of a handler that may no longer own the run. A v2 call keeps only the request correlation;
// an unexpected error is a recoverable `502` (the run is not stopped: the caller replays, and a persistent failure is ended by `complete`).
async function batchObserved(env,body,work,requestId){
 const correlation=safeRequestId(requestId)||crypto.randomUUID();
 try{return await withPredictionCorrelation(await work(),correlation);}
 catch(error){
  logPredictionFailure('submit',error,correlation,typeof body?.runId==='string'&&SAFE_LOG_ID.test(body.runId)?body.runId:null);
  return withPredictionCorrelation(json({error:'storage_error',recoverable:true,runId:SAFE_LOG_ID.test(String(body?.runId))?body.runId:null,...scheduledRunFields()},502),correlation);
 }
}
async function batchSubmit(env,body,requestId){
 const bad=validateBatchSubmitBody(body);if(bad)return bad;
 const notD1=await batchRequiresD1(env);if(notD1)return notD1;
 if(body.dryRun===true)return batchSubmitDryRun(env,body);
 const run=await checkedRun(env,body.runId);if(!run)return json({error:'Unknown run'},404);
 {const foreign=taskOwnerRefusal(run.taskId,body.taskId,run.runId);if(foreign)return foreign;}
 if(body.useHeld===true){
  const held=await loadJSON(env,BATCH_STAGE_KEY);
  const owned=(Array.isArray(held?.items)?held.items:[]).filter(item=>run.selectedIds.includes(item.filmId)&&!SETTLED_STATUSES.includes(run.results?.[item.filmId])&&!run.failures?.[item.filmId]);
  if(!owned.length)return json({error:'No held items for this run',code:'hold_unavailable',runId:body.runId},409);
  const items=owned.map(heldItemBody);
  const bytes=new TextEncoder().encode(JSON.stringify(items)).length;
  if(bytes>BATCH_RUNNER.submitMaxBodyBytes)return json({error:'Held items are '+bytes+' bytes, over the '+BATCH_RUNNER.submitMaxBodyBytes+' byte submit limit',code:'hold_too_large'},409);
  body={...body,items};delete body.useHeld;
  const filled=validateBatchSubmitBody(body);if(filled)return filled;
 }
 if(run.protocol!==BATCH_PROTOCOL)return wrongProtocolResponse();
 if(run.status!=='running')return json({error:'Run already complete',stopReason:run.stopReason||null,mustComplete:!!run.reason},409);
 // A caller's wrong epoch is the caller's error, not a loss of ownership: it must not stop the real owner's run, so it is not answered `lease_lost` (which records a stop).
 if(Number.isInteger(run.epoch)&&run.epoch!==body.epoch)return json({error:'Epoch does not match this run',code:'epoch_mismatch',runId:run.runId},409);
 // The gate comes first, before the global writer lease: an overlapping call of the run is answered `submit_in_flight` with the gate's remaining time, not as a busy writer. The same
 // call renews the lease and checks its owner, epoch and expiry. The gate's token is generated here; the X-Request-Id never identifies an owner.
 const token=crypto.randomUUID();
 const gate=await batchGateSet(env,run.runId,body.epoch,token,requestId,await contentHash(body.items));
 if(gate.status==='in_flight')return json({status:'busy',code:'submit_in_flight',reason:'submit_in_flight',retryAfterMs:gate.retryAfterMs,runId:run.runId,epoch:body.epoch,...scheduledRunFields()},409);
 if(gate.status!=='owned')return json(gate,409);
 try{
  // The run is read again under the gate: another call of this run may have finished (or the run completed) between the first read and the gate.
  const fresh=await checkedRun(env,body.runId);if(!fresh)return json({error:'Unknown run'},404);
  if(fresh.status!=='running')return json({error:'Run already complete',stopReason:fresh.stopReason||null,mustComplete:!!fresh.reason},409);
  // Global writer exclusion is unchanged: every prediction mutation still goes through the one writer lease, taken under the gate.
  // Nothing here goes through the shared step recorder (see batchObserved): a refusal writes nothing, not even a diagnostics step, and a lost lease or an error never reaches the unfenced stop recorder.
  return await batchObserved(env,body,()=>predictionWriter(env,owned=>batchSubmitLocked(owned,body,fresh,requestId,token)),requestId);
 }finally{try{await batchGateClear(env,run.runId,body.epoch,token);}catch{/* the gate expires by itself */}}
}
async function batchSubmitLocked(env,body,run,requestId,token){
 const startedAt=Date.now();
 if(run.systemicStopReason)return json({...runSummary(run),epoch:body.epoch,mustComplete:true,stopReason:run.systemicStopReason});
 const current=await loadJSON(env,profileKey);if(!current)return json({error:'Taste profile is not configured'},409);
 if(await runContractChanged(run))return contractChangedResponse();
 const change=current.profileHash!==run.tasteProfileHash?batchProfileChange(run,current):null;
 const freshness=await predictionFreshness(env,current),source=await loadJSON(env,ENRICHMENT_KEY+'sources/'+run.runId+'.json')||{};
 // Every authoritative write this call makes (film commits, the run record, retry records, the queue settlement, the progress record) goes through `guarded`: its D1 batch carries the guard.
 const ctx={run,freshness,change,source,epoch:body.epoch,token,requestId,guarded:{...env,[BATCH_COMMIT_GUARD]:{runId:run.runId,epoch:body.epoch,token}}};
 const saveRun=()=>batchGuardedCommit(env,ctx,()=>savePredictionRun(ctx.guarded,run));
 // ADR 0194 decision 3: with the stage in D1 the held rows this submit may settle are the ones it OBSERVES now (film, digest, holder); a hold that arrives later is never deleted by this submit.
 const observedStage=await (async()=>{const a=await auxAuthority(env);if(!a)return null;return new Map((await PredictionAux.readStage(auxDb(env))).items.map(item=>[item.filmId,item]));})();
 const results=[],regenerate=[];let stop=null;
 const lost=()=>stop==='gate_lost'||stop==='lease_lost';
 // A progress Event that an earlier holder checkpointed but did not publish is published first.
 try{await batchPublishIntent(env,ctx);}catch(error){if(error instanceof BatchGateLost)stop=error.status;else throw error;}
 const fail=(error,id,pushed)=>{
  if(error instanceof BatchGateLost)stop=error.status;else{stop='storage_error';try{console.log(JSON.stringify({event:'batch_submit_item_failed',requestId:SAFE_LOG_ID.test(String(requestId))?requestId:null,runId:SAFE_LOG_ID.test(run.runId)?run.runId:null,code:SAFE_LOG_ID.test(String(error?.code))?error.code:'unknown'}));}catch{/* a log never changes the outcome */}}
  if(!pushed)results.push({filmId:id,status:'blocked',reason:stop});
 };
 for(const item of body.items){
  const id=String(item.filmId);
  if(stop){results.push({filmId:id,status:'blocked',reason:stop});continue;}
  if(Date.now()-startedAt>BATCH_RUNNER.callBudgetMs){results.push({filmId:id,status:'deferred_budget'});continue;}
  let outcome=null;
  try{
   outcome=await batchSubmitItem(env,ctx,item);results.push(outcome.result);
   if(outcome.regenerate)regenerate.push(outcome.regenerate);
   if(outcome.stop)stop=outcome.stop;
   // Loss of the gate or the epoch is terminal for every mutable operation that follows: no checkpoint, no retry record, no settlement, no progress.
   if(!lost()){
    run.lastActivityAt=new Date().toISOString();
    const renewed=await batchGateRenew(env,run.runId,body.epoch,token);
    if(renewed.status==='owned')run.lastHeartbeatAt=renewed.value.heartbeatAt;else if(renewed.status==='gate_lost'||renewed.status==='lease_lost')stop=renewed.status;
   }
   // A result that was only in memory (a failure, a regeneration) when the gate was lost is not reported as an outcome: nothing of it was persisted, and the new holder decides it again.
   if(lost()&&outcome.result&&['validation_failure','needs_regeneration'].includes(outcome.result.status)){const at=results.indexOf(outcome.result);if(at>=0)results[at]={filmId:id,status:'blocked',reason:stop};if(outcome.regenerate)regenerate.pop();}
   if(!lost())await saveRun();
   // The retry record of a failed film goes to the queue at once, under the same guard.
   if(!lost()&&outcome.failure)await batchGuardedCommit(env,ctx,()=>batchRecordRetry(ctx.guarded,run,outcome.failure,outcome.result));
   if(!lost()&&outcome.failure)await saveRun();
   if(!lost()&&run.systemicStopReason)stop||=run.systemicStopReason;
  }catch(error){
   // A retry write that kept losing its swap while the gate is still ours leaves the run's own `retryHeal: pending` mark, which the stop or the next start writes; it is not a stop.
   if(outcome&&error?.code==='prediction_queue_conflict'&&await batchGateHeld(env,ctx)==='held'){run.retryHeal='pending';continue;}
   fail(error,id,!!outcome);
  }
 }
 const committed=results.some(r=>['created','recalculated','already_current'].includes(r.status));
 let queue=null,settlement=lost()?'pending':'settled';
 if(!lost()&&run.mode==='queued'){
  // Every film of the run that was written leaves the queue, not only this call's: a settlement that was lost earlier (`queueSettlement: "pending"`) is repeated by the next call from the run record, and a film already gone is not touched.
  const settled=Object.keys(run.results).filter(id=>SETTLED_STATUSES.includes(run.results[id]));
  try{
   queue=await atStage('queue_refresh',async()=>{const report=await loadJSON(env,'programme.json'),stored=await currentPredictionQueue(env,report,current,'batch_progress');if(!stored||!settled.length)return stored;return await batchGuardedCommit(env,ctx,async()=>await mutatePredictionQueue(ctx.guarded,guardedSettle(await advanceContext(env,report,current,stored),settled,'batch_progress'),'batch_progress',stored))||stored;});
  }catch(error){
   const held=catalogHeldQueueError(error);if(held)return ownedCatalogHeld('submit',held,requestId,run.runId,{results,committed,epoch:body.epoch,queueSettlement:'pending'});
   settlement='pending';
   if(error instanceof BatchGateLost)stop=error.status;else if(error?.code==='prediction_queue_conflict'){if(await batchGateHeld(env,ctx)!=='held')stop='gate_lost';}else{stop='storage_error';}
  }
 }
 if(queue&&!lost()){try{await batchProgress(env,ctx,queue);}catch(error){if(error instanceof BatchGateLost)stop=error.status;else stop||='storage_error';}}
 noteStep(env,()=>({bodyItems:body.items.length,created:results.filter(r=>r.status==='created').length,recalculated:results.filter(r=>r.status==='recalculated').length,alreadyCurrent:results.filter(r=>r.status==='already_current').length,failures:results.filter(r=>r.status==='validation_failure').length,deferredBudget:results.filter(r=>r.status==='deferred_budget').length,needsRegeneration:results.filter(r=>r.status==='needs_regeneration').length}));
 const answer={...runSummary(run),epoch:body.epoch,results,committed,queueSettlement:settlement,mustComplete:!!run.systemicStopReason,stopReason:run.systemicStopReason||null,remaining:queue?.pending.length??null,hotRemaining:queue?.priorityCount??null,coldRemaining:queue?.coldRemaining??null,...scheduledRunFields()};
 if(change){answer.profile={...change,body:current.profile,lineage:Array.isArray(current.lineage)?current.lineage:[]};answer.regenerate=regenerate;answer.action=change.scope==='global'?'complete':'continue';}
 else answer.profile={changed:false};
 if(stop&&['gate_lost','lease_lost'].includes(stop))return json({...answer,status:stop},409);
 // A storage failure after processing began carries the results and is recoverable by replaying the same body: it is not a stop of the run (a persistent failure is ended by `complete`).
 if(stop==='storage_error')return json({...answer,error:'storage_error',recoverable:true},502);
 if(!lost()){const settledIds=results.filter(r=>SETTLED_STATUSES.includes(r.status)||r.status==='validation_failure').map(r=>r.filmId);if(observedStage)await dropStagedRows(ctx.guarded,settledIds.map(id=>observedStage.get(id)));else await dropStagedFilmIds(ctx.guarded,settledIds);}
 return json(answer);
}
// A dry run reads and writes nothing: no lease, gate, run, queue or storage write. It validates each item with the same validators against the current contract and profile, and reports
// what the real call would answer. Membership of a manifest cannot be checked (no run is persisted), so `liveInput` says whether the film's input is still the dry-run manifest's.
async function batchSubmitDryRun(env,body){
 const current=await loadJSON(env,profileKey);if(!current)return json({error:'Taste profile is not configured'},409);
 const registry=(await fingerprintRegistryDigests()).registry;
 if(body.contract&&(body.contract.fingerprintSchemaVersion!==FINGERPRINT_SCHEMA_VERSION||(body.contract.fingerprintPromptVersion??1)!==FINGERPRINT_PROMPT_VERSION||body.contract.predictionPromptVersion!==PREDICTION_PROMPT_VERSION||body.contract.registryDigest!==registry))return json({error:'Contract changed; take a new dry-run manifest',code:'contract_changed',dryRun:true},409);
 const freshness=await predictionFreshness(env,current),report=await loadJSON(env,'programme.json'),ids=body.items.map(item=>String(item.filmId));
 const films=report?await readFilmsById(env,report,ids):new Map(),queue=await loadJSON(env,predictionQueueKey),results=[];
 for(const rawItem of body.items){
  const id=String(rawItem.filmId),film=films.get(id),state=film?await readFilmState(env,id):null,genres=film?.genres;
  let status='would_write',issues=null,stage=null;
  if(!film||!state){results.push({filmId:id,status:'not_eligible',liveInput:'not_eligible',dryRun:true});continue;}
  const item=withDerivedSource(rawItem,modelMetadata(film));
  let liveInput='same';
  if(item.inputHash){const plan=freshness.fingerprintUsable(state.fingerprint,genres,id)?'prediction_only':'fingerprint_and_prediction',entry={filmId:id,lane:queue?.priority?.[id]?.hot?'hot':'cold',plan,modelMetadata:batchCompact(modelMetadata(film)),...(plan==='prediction_only'?{fingerprint:batchCompact(state.fingerprint)}:{})};liveInput=(await batchFilmInputHash(entry))===item.inputHash?'same':'changed';}
  const current_=state.predictions?.current;
  if(item.failure){results.push({filmId:id,status:'validation_failure',error:'parse_error',validation:{stage:'caller_reported',reportedBy:'caller',issues:[],...(callerFailureClaim(item.failure)?{claimed:callerFailureClaim(item.failure)}:{})},liveInput,assessment:item.assessment!==undefined?'not_applicable':'not_sent',dryRun:true});continue;}
  let fingerprint=state.fingerprint;
  if(freshness.state(current_,fingerprint,genres,id)){results.push({filmId:id,status:'already_current',liveInput:'not_eligible',assessment:item.assessment!==undefined?'not_applicable':'not_sent',dryRun:true});continue;}
  if(item.fingerprint&&!freshness.fingerprintUsable(fingerprint,genres,id)){const found=fingerprintIssues(item.fingerprint,modelMetadata(film));if(found.length){issues=found;stage='fingerprint_schema';}else fingerprint={...item.fingerprint,filmId:id,fingerprintHash:await contentHash({...item.fingerprint,filmId:id}),fingerprintSchemaVersion:item.fingerprint.fingerprintSchemaVersion??FINGERPRINT_SCHEMA_VERSION};}
  if(!issues&&!freshness.fingerprintUsable(fingerprint,genres,id)&&!item.fingerprint){issues=[{path:'fingerprint',code:'required'}];stage='fingerprint_missing';}
  if(!issues){const found=predictionIssues(item.prediction);if(found.length){issues=found;stage='prediction_schema';}}
  if(!issues){const found=assessmentIssues(item.assessment,modelMetadata(film));if(found.length){issues=found;stage='assessment_schema';}}
  if(issues){results.push({filmId:id,status:'validation_failure',error:'parse_error',validation:{stage,reportedBy:'worker',issues},liveInput,assessment:item.assessment!==undefined?'not_applicable':'not_sent',dryRun:true});continue;}
  results.push({filmId:id,status,liveInput,assessment:item.assessment!==undefined?'would_write':'not_sent',dryRun:true});
 }
 return json({status:'dry_run',dryRun:true,runId:null,manifestHash:body.manifestHash||null,profile:{version:current.version,hash:current.profileHash},results,...scheduledRunFields()});
}
// batch_start is observed like next and submit (one `prediction_step_timing` line) but runs without the per-request authority and object scope those two use: a start
// writes a run, a lease and a queue, and the scope's reuse of identical reads assumes a step that already holds the lease.
async function timedBatchStep(env,step,body,requestId,work){
 let timer=null,timed=env;
 try{timer=createStepTimer();timed=stepTimedEnv(env,timer);}catch{timer=null;timed=env;}
 // The authority marker only, never the object scope: reads in this request reuse the marker until the request's own database writes (the lease acquire is the first), so the post-lease preflight reads it afresh.
 try{if(typeof PredictionD1!=='undefined'&&typeof PredictionD1.scopeRequest==='function')timed=PredictionD1.scopeRequest(timed);}catch{/* an unscoped start reads the marker every time */}
 // ADR 0196: the bucket every writer of this request holds refuses a write of the four families while the marker is closed (built AFTER the scope so its marker reads share the request's).
 timed=auxGuardedEnv(timed);
 let status=null;
 try{const response=await work(timed);status=response&&typeof response.status==='number'?response.status:null;return response;}
 catch(error){status=0;throw error;}
 finally{try{if(timer){const id=typeof requestId==='string'&&SAFE_LOG_ID.test(requestId)?requestId:null,run=typeof body?.runId==='string'&&SAFE_LOG_ID.test(body.runId)?body.runId:null;console.log(JSON.stringify(timer.summary(step,{requestId:id,runId:run,status})));}}catch{/* logging never changes the outcome */}}
}
async function savePredictionRun(env,run){await saveJSON(env,runKey(run.runId),run);await saveJSON(env,ENRICHMENT_KEY+'latest-run.json',run);await diagnosticCheckpoint(env,run);}
// The document GET /api/enrichment/schema serves; the batch manifest carries the same one, so a model needs no further read.
function enrichmentSchemaDocument(){return {profile:{schemaVersion:1,required:['ratingScale','positiveSignals','negativeSignals','characterLogic','pace','payoffEnding','genrePreferences','comedyPreferences','horrorPreferences','scifiAdventurePreferences','actionPreferences','anchorFilms','hardSkips','calibration'],textFields:['ratingScale','characterLogic','pace','payoffEnding','genrePreferences','comedyPreferences','horrorPreferences','scifiAdventurePreferences','actionPreferences','calibration'],listFields:['positiveSignals','negativeSignals','hardSkips'],anchorFilms:{title:'string',rating:'0.5…5.0 in 0.5 steps',reason:'string'}},fingerprint:{fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,plotMechanics:MECHANICS,execution:EXECUTION,requiredExecution:GENERAL_EXECUTION,moodLabels:'2–4 short labels, preferably canonical vocabulary labels; raw input preserved and mapped at write',moodVocabulary:MOOD_LABELS,moodMapping:{version:MOOD_MAPPING_VERSION,groups:MOOD_GROUPS},strengths:'short string array',risks:'short string array',confidence:CONFIDENCE,sourceBasis:SOURCE_BASIS,sourceRefs:'URL or model_knowledge',evidence:'optional; see contract.fingerprint.evidence. Omitting the key keeps a legacy fingerprint'},prediction:{predictedRating:'0.5…5.0 in 0.5 steps',probability4Plus:'number 0…1',confidence:CONFIDENCE,matchSignals:'0–3 short strings',mainRisk:'one short string or null',moodLabels:'2–4 short labels, preferably canonical vocabulary labels; raw input preserved and mapped at write',moodVocabulary:MOOD_LABELS,moodMapping:{version:MOOD_MAPPING_VERSION,groups:MOOD_GROUPS}},contract:schemaContract(),rules:['Do not infer execution quality from premise alone; use unknown if evidence is insufficient','Do not use or request actual user rating for the target film','Check the fingerprint and prediction against contract before prediction_batch_submit: every required execution dimension present, every enum value from its list (payoff and ending_quality use weak, mixed, strong, unknown, not medium; hero_vulnerability uses low, mixed, high, unknown), moodLabels 2–4 labels. A rejected item returns results[].validation.issues with the field path and code.']};}
// GET /api/enrichment/runner (and the enrichment_runner MCP tool): the live runner contract. Since ADR 0167 batch runner v2 is the only protocol; the one-film
// v5 start/next/submit routes and tools are retired. pipelineVersion stays the stored run format of the shared run records, unchanged by the retirement.
function predictionRunnerContract(){return {pipelineVersion:5,protocol:BATCH_PROTOCOL,retiredProtocols:['v5'],leaseTtlMs:RUNNER_LEASE_TTL,heartbeat:'/api/enrichment/heartbeat',complete:'/api/enrichment/complete',read:'/api/enrichment/runner',itemFailures:{reportVia:'batch submit items[].failure {kind, reason}',allowedKinds:['parse_error','validation_error'],retryable:true,retryBaseMs:3600000,validation:{preflight:'prediction_batch_validate (read-only) or GET /api/enrichment/schema contract',reportedVia:'batch submit results[].validation {stage, reportedBy, issues[{path, code}]}',issueCodes:ISSUE_CODES}},batchRunner:{version:BATCH_RUNNER.version,protocol:BATCH_PROTOCOL,start:'/api/enrichment/batch/start',submit:'/api/enrichment/batch/submit',hold:'/api/enrichment/batch/hold',manifestFormat:BATCH_MANIFEST_FORMAT,...batchLimits(),requires:{predictionAuthority:'d1'}},instructions:['Batch start returns already_running: exit immediately, do not adopt its runId.','One batch start returns the whole manifest with the profile, schema and metadata (a deferred start returns a receipt instead and the manifest is read with prediction_batch_manifest once ready, ADR 0193); generate, validate, hold and submit its films in groups of at most 10 with the runId and lease epoch.','Lease TTL is 12 minutes. Heartbeat before model calls and at least every 5 minutes during long calls; every start, hold and submit also renews it.','Malformed or invalid per-film output: submit {filmId,failure:{kind,reason}} and continue. Never complete for one item failure.','Complete with reason manifest_spent once every manifest film is settled while ready films remain in the queue; omit reason when the queue is empty; otherwise pass the real systemic stop reason.','A formed response does not prove the client received it. Send or read X-Request-Id. On an external or systemic stop, complete may include fault {origin, failedStep, providerErrorCode, httpStatus, receivedRequestId}. Omit fault when the cause is unknown. A fault on a normal completion is rejected.']};}
function runSummary(r){return {runId:r.runId,processed:Object.values(r.results||{}).filter(x=>x!=='failed').length,batchCount:r.batchCount||1,lastHeartbeatAt:r.lastHeartbeatAt||null,hotRemaining:r.hotRemaining??null,coldRemaining:r.coldRemaining??null,stopReason:r.stopReason||null,sourceProgrammeRunId:r.sourceProgrammeRunId,tasteProfileVersion:r.tasteProfileVersion,tasteProfileHash:r.tasteProfileHash,fingerprintSchemaVersion:r.fingerprintSchemaVersion,predictionPromptVersion:r.predictionPromptVersion,eligibleCount:r.eligibleCount,selectedCount:r.selectedIds.length,batchSize:r.batchSize??r.selectedIds.length,adaptivePlan:r.adaptivePlan||null,deadlineAt:r.deadlineAt||null,status:r.status,trigger:r.trigger||'manual',startedAt:r.createdAt,finishedAt:r.completedAt||null,checked:Object.keys(r.results||{}).length,added:Object.values(r.results||{}).filter(x=>x==='created').length,updated:Object.values(r.results||{}).filter(x=>x==='recalculated').length,failed:Object.keys(r.failures||{}).length,hotProcessed:Object.entries(r.results||{}).filter(([id,status])=>['created','recalculated'].includes(status)&&r.selectionKind?.[id]==='hot').length,coldProcessed:Object.entries(r.results||{}).filter(([id,status])=>['created','recalculated'].includes(status)&&r.selectionKind?.[id]==='cold').length};}
async function checkedRun(env,id){if(!isText(id,100))return null;return loadJSON(env,runKey(id));}
// AIR-510: a truncated MCP start text is not a usable manifest. The already-owned run keeps the exact start answer; this read returns it without a second prediction_batch_start.
function usableBatchManifest(value){
 if(!isObject(value)||typeof value.runId!=='string'||!value.runId)return false;
 if(!isObject(value.lease)||!Number.isInteger(value.lease.epoch)||value.lease.epoch<1)return false;
 if(typeof value.manifestHash!=='string'||!/^[0-9a-f]{64}$/.test(value.manifestHash))return false;
 if(!isObject(value.profile)||!isObject(value.profile.body))return false;
 if(!isObject(value.contract?.schema?.contract?.fingerprint?.evidence))return false;
 if(!Array.isArray(value.films)||!value.films.length)return false;
 return value.films.every(film=>isObject(film)&&typeof film.filmId==='string'&&isObject(film.modelMetadata));
}
function parseBatchStartToolText(text){
 if(typeof text!=='string'||!text)return {ok:false,code:'truncated_manifest'};
 try{
  const value=JSON.parse(text);
  return usableBatchManifest(value)?{ok:true,manifest:value}:{ok:false,code:'incomplete_manifest'};
 }catch{return {ok:false,code:'truncated_manifest'};}
}
function batchManifestEnvelope(stored){
 const {films,profile,contract,...rest}=stored;
 return {kind:'envelope',...rest,parts:[{kind:'profile'},{kind:'contract'},...films.map((film,index)=>({kind:'film',index,filmId:film.filmId}))]};
}
// AIR-588 (C, ADR 0205): the compact answer of a start that asked for `answer: envelope`. It is the readback envelope of the stored manifest (the same fields, `runId`, `lease` with its epoch,
// `manifestHash`, `limits`, the part list), served only after that manifest was stored, plus `answer` and where to read the parts. The full manifest, its hash and the run are unchanged:
// the caller assembles profile, contract and every film part, checks them against `manifestHash`, and submits under the same runId and epoch as with a full answer.
function batchStartEnvelope(stored){
 return {...batchManifestEnvelope(stored),answer:'envelope',read:{tool:'prediction_batch_manifest',parts:['profile','contract','film']}};
}
function batchManifestPartBody(stored,part,filmId){
 if(part==='envelope')return batchManifestEnvelope(stored);
 if(part==='profile')return {kind:'profile',runId:stored.runId,manifestHash:stored.manifestHash,profile:stored.profile};
 if(part==='contract')return {kind:'contract',runId:stored.runId,manifestHash:stored.manifestHash,contract:stored.contract};
 if(part==='film'){
  const film=(stored.films||[]).find(item=>item.filmId===filmId);
  if(!film)return null;
  return {kind:'film',runId:stored.runId,manifestHash:stored.manifestHash,film};
 }
 return undefined;
}
function heldItemBody(item){return batchPick(item,BATCH_ITEM_KEYS);}
// ADR 0194 decision 3: with the stage in D1 a drop names the rows the caller OBSERVED (film, digest, holder), never a film id alone, so a replacement hold of the same film survives; the legacy stage
// drops by film id as it always did.
async function dropStagedRows(env,rows){
 const list=(rows||[]).filter(Boolean);
 if(!list.length)return;
 const aux=await auxAuthority(env);
 if(aux){await PredictionAux.dropStageRows(auxDb(env),aux,list.map(row=>({filmId:row.filmId,itemDigest:row.itemDigest,heldByRunId:row.origin?.runId??null})),{guard:auxGuardOf(env),writer:env?.[WRITER_OWNER]||null});return;}
 await dropStagedFilmIds(env,list.map(row=>row.filmId));
}
async function dropStagedFilmIds(env,ids){
 const remove=new Set((ids||[]).filter(Boolean));
 if(!remove.size)return;
 await mergeStoredJSON(env,BATCH_STAGE_KEY,{items:[]},current=>{
  const items=(Array.isArray(current.items)?current.items:[]).filter(item=>!remove.has(item.filmId));
  if(items.length===(Array.isArray(current.items)?current.items.length:0))return null;
  return {items,updatedAt:new Date().toISOString()};
 });
}
const stagedFilmInputHash=async(filmId,plan,metadata,fingerprint)=>(await contentHash({filmId,plan,modelMetadata:batchCompact(metadata||{}),fingerprintHash:fingerprint?.fingerprintHash||null})).slice(0,24);
function stageOriginStale(item,profile,registry){
 const origin=item?.origin;
 if(!origin)return 'stale_contract';
 if(origin.tasteProfileHash!==profile.profileHash)return 'stale_profile';
 if(origin.fingerprintSchemaVersion!==FINGERPRINT_SCHEMA_VERSION||(origin.fingerprintPromptVersion??1)!==FINGERPRINT_PROMPT_VERSION||origin.predictionPromptVersion!==PREDICTION_PROMPT_VERSION||origin.registryDigest!==registry)return 'stale_contract';
 return null;
}
const DRAIN_KEEP_ON_STAGE=new Set(['blocked','storage_error']);
async function drainBatchStage(env,run,gate,profile){
 const staged=await loadJSON(env,BATCH_STAGE_KEY);
 const rows=Array.isArray(staged?.items)?staged.items:[];
 const committed=[],dropped=[],remove=new Set();
 if(!rows.length)return {committed,dropped};
 const registry=(await fingerprintRegistryDigests()).registry;
 const freshness=await predictionFreshness(env,profile);
 const source=await loadJSON(env,ENRICHMENT_KEY+'sources/'+run.runId+'.json')||{};
 const report=await loadJSON(env,'programme.json');
 const queue=await loadJSON(env,predictionQueueKey);
 const ctx={run,freshness,change:null,source,epoch:gate.epoch,token:gate.token,requestId:gate.requestId,guarded:{...env,[BATCH_COMMIT_GUARD]:{runId:run.runId,epoch:gate.epoch,token:gate.token}}};
 const saveRun=()=>batchGuardedCommit(env,ctx,()=>savePredictionRun(ctx.guarded,run));
 // With the sources in D1 a new revision commits WITH the run write (the run's binding moves in the same batch); the legacy path writes the R2 object.
 const saveSources=async()=>{
  const a=await auxAuthority(env);
  if(!a){await saveJSON(ctx.guarded,ENRICHMENT_KEY+'sources/'+run.runId+'.json',source);return;}
  const plan=await PredictionAux.planSource(auxDb(env),a,run.runId,source);
  if(!plan.written)return;
  run.sourceRevision=plan.revision;run.sourceHash=plan.hash;
  ctx.guarded[COMMIT_EXTRA_KEY]={runId:run.runId,statements:[...PredictionAux.guardsFor(a,{runId:run.runId,epoch:gate.epoch,token:gate.token},{fence:'run'}),...plan.statements]};
  try{await saveRun();}finally{delete ctx.guarded[COMMIT_EXTRA_KEY];}
 };
 for(const row of rows){
  const id=row.filmId,stale=stageOriginStale(row,profile,registry);
  if(stale){dropped.push({filmId:id,reason:stale});remove.add(id);continue;}
  const films=await readFilmsById(env,report,[id]),film=films.get(id),state=await readFilmState(env,id);
  const plan=film&&freshness.fingerprintUsable(state.fingerprint,film.genres,id)?'prediction_only':'fingerprint_and_prediction';
  const liveHash=film?await stagedFilmInputHash(id,plan,modelMetadata(film),plan==='prediction_only'?state.fingerprint:null):null;
  if(!row.origin?.filmInputHash||!liveHash||row.origin.filmInputHash!==liveHash){dropped.push({filmId:id,reason:'stale_input'});remove.add(id);continue;}
  if(!run.selectedIds.includes(id)){
   run.selectedIds=[id,...run.selectedIds];run.batchIds=[id,...(run.batchIds||run.selectedIds)];
   run.selectionKind[id]=queue?.priority?.[id]?.hot?'hot':'cold';
   run.baseline[id]=state.predictions?.current?.generatedAt||null;
   if(film)source[id]=modelMetadata(film);
   await saveSources();
  }
  const item=heldItemBody(row);
  // ADR 0194 decision 2: with the stage in D1 the staged row's deletion commits in the same batch as the film's prediction (extra statements of that batch), never as a separate later step.
  const settleAux=row.itemDigest?await auxAuthority(env):null;
  ctx.guarded[COMMIT_EXTRA_KEY]=settleAux?{filmId:id,statements:PredictionAux.stageSettleStatements(settleAux,id,row.itemDigest,row.origin?.runId??null)}:undefined;
  let outcome;try{outcome=await batchSubmitItem(env,ctx,item);}finally{delete ctx.guarded[COMMIT_EXTRA_KEY];}
  if(outcome.stop||DRAIN_KEEP_ON_STAGE.has(outcome.result?.status)){
   run.selectedIds=run.selectedIds.filter(filmId=>filmId!==id);
   run.batchIds=(run.batchIds||[]).filter(filmId=>filmId!==id);
   await saveRun();
   break;
  }
  if(SETTLED_STATUSES.includes(outcome.result?.status))committed.push(id);
  else{
   dropped.push({filmId:id,reason:outcome.result?.status||'dropped'});
   run.selectedIds=run.selectedIds.filter(filmId=>filmId!==id);
   run.batchIds=(run.batchIds||[]).filter(filmId=>filmId!==id);
  }
  remove.add(id);
  if(outcome.failure)await batchGuardedCommit(env,ctx,()=>batchRecordRetry(ctx.guarded,run,outcome.failure,outcome.result));
  await saveRun();
 }
 const settled=Object.keys(run.results||{}).filter(id=>SETTLED_STATUSES.includes(run.results[id]));
 if(settled.length&&run.mode==='queued'){
  const current=profile;
  try{
   await atStage('queue_refresh',async()=>{const report=await loadJSON(env,'programme.json'),stored=await currentPredictionQueue(env,report,current,'batch_progress');if(!stored||!settled.length)return stored;return await batchGuardedCommit(env,ctx,async()=>await mutatePredictionQueue(ctx.guarded,guardedSettle(await advanceContext(env,report,current,stored),settled,'batch_progress'),'batch_progress',stored))||stored;});
  }catch{/* the next submit of this run repeats settlement */}
 }
 if(remove.size)await dropStagedRows(ctx.guarded,[...remove].map(id=>rows.find(row=>row.filmId===id)));
 return {committed,dropped};
}
async function ownedBatchHoldPart(env,runId,part,filmId){
 const held=await loadJSON(env,BATCH_STAGE_KEY);
 if(part==='hold')return {kind:'hold',runId,epoch:null,manifestHash:null,filmIds:Array.isArray(held?.items)?held.items.map(item=>item.filmId):[]};
 const row=(Array.isArray(held?.items)?held.items:[]).find(item=>item.filmId===filmId);
 if(!row)return null;
 return {kind:'item',runId,originRunId:row.origin?.runId||null,itemDigest:row.itemDigest||null,item:heldItemBody(row)};
}
async function batchHold(env,body){
 if(!isObject(body)||!isText(body.runId,100)||!Number.isInteger(body.epoch)||body.epoch<1)return json({error:'Invalid runId or epoch'},400);
 if(!Array.isArray(body.items)||!body.items.length||body.items.length>BATCH_RUNNER.submitMaxItems)return json({error:'Expected 1–'+BATCH_RUNNER.submitMaxItems+' items'},400);
 {const unknown=unknownItemKeyIssues(body.items,BATCH_ITEM_KEYS);if(unknown.length)return json({error:'Invalid item',issues:unknown},400);}
 for(const item of body.items)if(!isObject(item)||!isText(item.filmId,100)||item.fingerprint!==undefined&&!isObject(item.fingerprint)||item.prediction!==undefined&&!isObject(item.prediction)||item.failure!==undefined&&!isObject(item.failure)||item.assessment!==undefined&&!isObject(item.assessment))return json({error:'Invalid item'},400);
 if(new Set(body.items.map(item=>String(item.filmId))).size!==body.items.length)return json({error:'Duplicate filmId'},400);
 const bytes=new TextEncoder().encode(JSON.stringify(body.items)).length;
 if(bytes>BATCH_RUNNER.submitMaxBodyBytes)return json({error:'This group is '+bytes+' bytes, over the '+BATCH_RUNNER.submitMaxBodyBytes+' byte hold limit'},400);
 const notD1=await batchRequiresD1(env);if(notD1)return notD1;
 const run=await checkedRun(env,body.runId);if(!run)return json({error:'Unknown run'},404);
 {const foreign=taskOwnerRefusal(run.taskId,body.taskId,run.runId);if(foreign)return foreign;}
 if(run.protocol!==BATCH_PROTOCOL)return wrongProtocolResponse();
 if(run.status!=='running')return json({error:'Run already complete',stopReason:run.stopReason||null},409);
 if(Number.isInteger(run.epoch)&&run.epoch!==body.epoch)return json({error:'Epoch does not match this run',code:'epoch_mismatch',runId:run.runId},409);
 const lease=await runnerLease(env,run.runId);if(lease.status!=='owned')return json(lease,409);
 const selected=new Set(run.selectedIds||[]);
 const missing=body.items.map(item=>item.filmId).filter(id=>!selected.has(id));
 if(missing.length)return json({error:'Film not in manifest',code:'not_in_manifest',filmIds:missing},409);
 const registry=(await fingerprintRegistryDigests()).registry;
 const source=await loadJSON(env,ENRICHMENT_KEY+'sources/'+run.runId+'.json')||{};
 const freshness=await predictionFreshness(env,await loadJSON(env,profileKey));
 const originBase={runId:run.runId,tasteProfileHash:run.tasteProfileHash,fingerprintSchemaVersion:run.fingerprintSchemaVersion,fingerprintPromptVersion:run.fingerprintPromptVersion??1,predictionPromptVersion:run.predictionPromptVersion,registryDigest:run.fingerprintRegistryDigest??registry};
 const incoming=[];
 for(const item of body.items){
  const stored=heldItemBody(item);
  const state=await readFilmState(env,item.filmId);
  const metadata=source[item.filmId]||{};
  const plan=freshness.fingerprintUsable(state.fingerprint,metadata.genres,String(item.filmId))?'prediction_only':'fingerprint_and_prediction';
  const origin={...originBase,filmInputHash:await stagedFilmInputHash(item.filmId,plan,metadata,plan==='prediction_only'?state.fingerprint:null)};
  incoming.push({...stored,itemDigest:await batchItemDigest(item.filmId,stored),origin,stagedAt:new Date().toISOString()});
 }
 let refuse=null,replayed=[],added=[];
 let next;
 try{
  next=await mergeStoredJSON({...env,[BATCH_COMMIT_GUARD]:{runId:run.runId,epoch:Number.isInteger(run.epoch)?run.epoch:body.epoch,token:null}},BATCH_STAGE_KEY,{items:[]},current=>{
   const byId=new Map((Array.isArray(current.items)?current.items:[]).map(item=>[item.filmId,item]));
   replayed=[];added=[];
   for(const item of incoming){
    const prev=byId.get(item.filmId);
    if(prev){
     if(prev.itemDigest===item.itemDigest){replayed.push(item.filmId);continue;}
     refuse={error:'Held item digest conflict',code:'hold_conflict',filmId:item.filmId};return null;
    }
    byId.set(item.filmId,item);added.push(item.filmId);
   }
   if(!added.length)return null;
   const items=[...byId.values()];
   if(items.length>BATCH_RUNNER.submitMaxItems){refuse={error:'Hold would exceed '+BATCH_RUNNER.submitMaxItems+' items',code:'hold_too_large'};return null;}
   const heldBytes=new TextEncoder().encode(JSON.stringify(items.map(heldItemBody))).length;
   if(heldBytes>BATCH_RUNNER.submitMaxBodyBytes){refuse={error:'Held items are '+heldBytes+' bytes, over the '+BATCH_RUNNER.submitMaxBodyBytes+' byte submit limit',code:'hold_too_large'};return null;}
   return {items,updatedAt:new Date().toISOString()};
  });
 }catch(error){
  if(String(error.message)==='Stored JSON changed during write')return json({error:'Hold write contention',code:'hold_contention',runId:run.runId},409);
  throw error;
 }
 if(refuse)return json(refuse,409);
 const filmIds=(next.items||[]).map(item=>item.filmId);
 return json({status:'held',runId:run.runId,epoch:body.epoch,manifestHash:run.manifestHash,filmIds,replayed,added,counts:{held:filmIds.length,added:added.length,replayed:replayed.length}});
}
function assembleOwnedBatchManifest(envelope,profilePart,contractPart,filmParts){
 if(!isObject(envelope)||envelope.kind!=='envelope'||!Array.isArray(envelope.parts))return {ok:false,code:'incomplete_manifest'};
 if(!isObject(profilePart)||profilePart.kind!=='profile'||profilePart.manifestHash!==envelope.manifestHash)return {ok:false,code:'incomplete_manifest'};
 if(!isObject(contractPart)||contractPart.kind!=='contract'||contractPart.manifestHash!==envelope.manifestHash)return {ok:false,code:'incomplete_manifest'};
 const wanted=envelope.parts.filter(part=>part.kind==='film');
 if(!Array.isArray(filmParts)||filmParts.length!==wanted.length)return {ok:false,code:'incomplete_manifest'};
 const byId=new Map(filmParts.filter(part=>isObject(part)&&part.kind==='film'&&part.manifestHash===envelope.manifestHash&&isObject(part.film)).map(part=>[part.film.filmId,part.film]));
 const films=[];
 for(const part of wanted){const film=byId.get(part.filmId);if(!film)return {ok:false,code:'incomplete_manifest'};films.push(film);}
 const {kind,parts,...rest}=envelope;
 const manifest={...rest,profile:profilePart.profile,contract:contractPart.contract,films};
 return usableBatchManifest(manifest)?{ok:true,manifest}:{ok:false,code:'incomplete_manifest'};
}
// ADR 0194 decision 5: one bounded part, read from the pieces that cover it and verified against their digests, then checked against the DURABLE run identity (the manifest hash and the epoch), never against the
// mutable `run.selectedIds` (which can also carry committed drained held ids). A corrupt, short or mismatching manifest is `manifest_unavailable`, fail closed.
async function auxManifestPart(env,aux,run,runId,part,filmId,preparing){
 const unavailable={status:409,body:{error:'manifest_unavailable',code:'manifest_unavailable'}};
 let got;
 try{got=await PredictionAux.readManifestPart(auxDb(env),runId,part,filmId);}catch(error){if(error?.code==='prediction_aux_corrupt')return unavailable;throw error;}
 // Pending only while a preparation (the claim's `prep` mark or the persist gate) is live; for a ready run a missing row is lost durable state, never a wait.
 if(got===null)return preparing?{status:409,body:{error:'manifest_pending',code:'manifest_pending',retryAfterMs:START_POLL_MS}}:unavailable;
 if(got===undefined)return {status:404,body:{error:'Unknown film',code:'unknown_film'}};
 if(got.manifestHash!==run.manifestHash)return unavailable;
 // Every part carries the identity the manifest was stored under: it must be this run and this epoch.
 if(!got.meta||got.meta.runId!==runId||(Number.isInteger(run.epoch)&&got.meta.epoch!==run.epoch))return unavailable;
 if(part==='envelope'){
  if(Number.isInteger(run.epoch)&&Number.isInteger(got.envelope?.lease?.epoch)&&got.envelope.lease.epoch!==run.epoch)return unavailable;
  return {status:200,body:{kind:'envelope',...got.envelope,parts:[{kind:'profile'},{kind:'contract'},...got.filmIds.map((id,index)=>({kind:'film',index,filmId:id}))]}};
 }
 return {status:200,body:{kind:part,runId,manifestHash:got.manifestHash,[part]:got.value}};
}
// A part readback writes nothing, so it runs as a timed step with the per-request authority marker scope (the markers are read once for the request, not once per key) and its own `prediction_step_timing` line.
async function ownedBatchManifest(env,runId,opts={}){return timedBatchStep(env,'batch_manifest',{runId},null,timed=>ownedBatchManifestRead(timed,runId,opts));}
async function ownedBatchManifestRead(env,runId,{part='envelope',filmId,taskId}={}){
 if(!isText(runId,100))return {status:400,body:{error:'Invalid runId',code:'invalid_run_id'}};
 if(taskId!==undefined&&!isTaskId(taskId))return {status:400,body:{error:'Invalid taskId',code:'invalid_task_id'}};
 if(!['envelope','profile','contract','film','hold','item'].includes(part))return {status:400,body:{error:'Invalid part',code:'invalid_part'}};
 if((part==='film'||part==='item')&&(typeof filmId!=='string'||!filmId))return {status:400,body:{error:'filmId required',code:'invalid_film_id'}};
 // ADR 0193: the run id of a deferred start is derived from its key. Its terminal outcome wins over any partial run row, and an invocation whose preparation never produced a run, an outcome or a live
// claim is a typed loss, never `unknown_run`.
 const deferredRun=DEFERRED_RUN_PATTERN.test(runId);
 if(deferredRun){
  const outcome=await loadJSON(env,START_OUTCOME_PREFIX+runId+'.json');
  if(outcome&&(outcome.phase==='refused'||outcome.phase==='failed'))return {status:409,body:{error:'start_not_ready',code:outcome.phase==='refused'?'start_refused':'start_failed',outcomeCode:outcome.code||null,reason:outcome.reason||null,runId}};
 }
 const run=await checkedRun(env,runId);
 if(!run){
  // ADR 0188: a keyed start still preparing its run answers pending, not unknown.
  const claimed=await loadJSON(env,RUNNER_LEASE_KEY);
  if(claimed?.runId===runId&&Number(claimed.expiresAt)>Date.now()){
   // ADR 0195: a start still preparing its run is read back only by the Task that holds the claim.
   if((claimed.taskId??null)!==(taskId??null))return {status:409,body:{error:'wrong_owner',code:'wrong_owner',reason:'wrong_owner',runId}};
   return {status:409,body:{error:'manifest_pending',code:'manifest_pending',retryAfterMs:START_POLL_MS}};
  }
  if(deferredRun)return {status:409,body:{error:'start_not_ready',code:'start_failed',outcomeCode:'start_lost',reason:null,runId}};
  return {status:404,body:{error:'Unknown run',code:'unknown_run'}};
 }
 {const foreign=taskOwnerRefusal(run.taskId,taskId,runId);if(foreign)return {status:foreign.status,body:await foreign.json()};}
 const lease=await loadJSON(env,RUNNER_LEASE_KEY);
 if(!(lease?.runId===runId&&Number(lease.expiresAt)>Date.now()))return {status:409,body:{error:'lease_lost',code:'lease_lost'}};
 // A deferred run is served only after its readiness edit: while the preparation mark is set the answer is pending, whatever is already stored.
 if(deferredRun&&lease.prep)return {status:409,body:{error:'manifest_pending',code:'manifest_pending',retryAfterMs:START_POLL_MS}};
 if(run.protocol!==BATCH_PROTOCOL)return {status:409,body:{error:'wrong_protocol',code:'wrong_protocol'}};
 if(run.status!=='running')return {status:409,body:{error:'Run already complete',code:'run_not_running'}};
 if(part==='hold'||part==='item'){
  const held=await ownedBatchHoldPart(env,runId,part,filmId);
  if(held==null)return {status:404,body:{error:'Unknown held film',code:'unknown_film'}};
  return {status:200,body:held};
 }
 {const aux=await auxAuthority(env);if(aux)return auxManifestPart(env,aux,run,runId,part,filmId,Boolean(lease?.prep||lease?.submitGate));}
 const stored=await loadJSON(env,ENRICHMENT_KEY+'batch-manifest/'+runId+'.json');
 if(stored==null)return {status:409,body:{error:'manifest_pending',code:'manifest_pending',retryAfterMs:START_POLL_MS}};
 if(!usableBatchManifest(stored))return {status:409,body:{error:'manifest_unavailable',code:'manifest_unavailable'}};
 const body=batchManifestPartBody(stored,part,filmId);
 if(body==null)return {status:404,body:{error:'Unknown film',code:'unknown_film'}};
 return {status:200,body};
}
// A run is bound to the fingerprint schema, both prompt versions and the registry it started with (ADR-0035 section 6);
// a deploy that changes any of them ends it, as a profile publication does. A run from before the prompt version was
// recorded is bound to version 1, the reading of every earlier fingerprint.
async function runContractChanged(run){
 const registry=(await fingerprintRegistryDigests()).registry;
 return run.fingerprintSchemaVersion!==FINGERPRINT_SCHEMA_VERSION||(run.fingerprintPromptVersion??1)!==FINGERPRINT_PROMPT_VERSION||run.predictionPromptVersion!==PREDICTION_PROMPT_VERSION||(run.fingerprintRegistryDigest??registry)!==registry;
}
const contractChangedResponse=()=>json({error:'Contract changed; start a new run',code:'contract_changed'},409);
async function enrichmentComplete(env,body,requestId){
 const run=await checkedRun(env,body?.runId);if(!run)return json({error:'Unknown run'},404);
 {const foreign=taskOwnerRefusal(run.taskId,body.taskId,run.runId);if(foreign)return foreign;}
 if(run.status==='complete'||run.status==='partial'){
  const replay=run.event||{id:'enrichment-'+run.runId,type:'enrichment',at:run.completedAt,...run.counts};
  if(isBatchV2Run(run))await parkAndFlushRunEvent(env,replay,run.runId);else await writeEvent(env,replay);
  await runnerLease(env,run.runId,'release');await settleExpiredDiagnostics(env);return json({runId:run.runId,status:run.status,counts:run.counts,...(run.event||{})});
 }
 const fault=readCallerFault(body);if(fault.rejected)return json({error:'Invalid fault'},400);
 const faultReason=typeof body.reason==='string'&&!NORMAL_COMPLETE.includes(body.reason)?systemicReason(body.reason):null;
 if(fault.value&&!FAULT_REASONS.includes(faultReason))return json({error:'Fault requires an external stop reason'},400);
 const attributed=externalAttribution(faultReason,fault.value);if(attributed)run.callerFault=attributed;
 const lease=await runnerLease(env,run.runId);if(lease.status!=='owned')return json(lease,409);run.lastHeartbeatAt=lease.heartbeatAt;
 // Transferable stage outlives this run (AIR-510 owner decision): external_termination releases the lease so the next Task can drain.
 if(body.reason&&!NORMAL_COMPLETE.includes(body.reason)){const stopped=await recordRunStop(env,run.runId,systemicReason(body.reason),{callerFault:run.callerFault||null});await settleExpiredDiagnostics(env);return json(stopped);}
 // ADR 0136: spending every selected manifest film is a normal complete for batch_v2 even when the global queue still has ready films. Unsubmitted / deferred_budget slots fail closed; profile/contract/lease stops stay as they are.
 if(body.reason==='manifest_spent'){
  if(run.protocol!==BATCH_PROTOCOL)return json({error:'manifest_spent is accepted only for a batch_v2 run'},400);
  if(!manifestFullySpent(run))return json({error:'Manifest not spent; continue submit',code:'manifest_not_spent',runId:run.runId,unspent:run.selectedIds.filter(id=>!manifestFilmSpent(run,id))},409);
 }
 // Fence profile and contract drift for reasonless complete and for manifest_spent: a change after the last submit must not be reported as a normal spent success (ADR 0136). The caller then completes with reason profile_changed / runner_aborted.
 const fenceDrift=!body.reason||body.reason==='manifest_spent';
 const profile=await loadJSON(env,profileKey);if(profile?.profileHash!==run.tasteProfileHash&&fenceDrift)return json({error:'Profile changed; start a new run'},409);
 if(fenceDrift&&await runContractChanged(run))return contractChangedResponse();
 if(run.mode==='queued'&&(!body.reason||['queue_empty','eligible_queue_empty','parse_error'].includes(body.reason))&&!run.systemicStopReason){let queue;try{queue=await atStage('queue_refresh',async()=>currentPredictionQueue(env,await loadJSON(env,'programme.json'),profile,'completion_check'));}catch(error){const held=catalogHeldQueueError(error);if(held)return ownedCatalogHeld('complete',held,requestId,run.runId);throw error;}if(queueReadyIds(queue).some(id=>!run.failures[id]))return json({error:'Queue not empty; continue next',runId:run.runId,hotRemaining:queue.priorityCount,coldRemaining:queue.coldRemaining},409);}
 const states=await Promise.all(run.selectedIds.map(id=>readFilmState(env,id)));let created=0,recalculated=0,pending=0;
 const freshness=await predictionFreshness(env,profile),source=freshness.needsGenres||isBatchV2Run(run)?await loadJSON(env,ENRICHMENT_KEY+'sources/'+run.runId+'.json')||{}:{};
 for(let i=0;i<states.length;i++){const s=states[i],p=s.predictions?.current,id=run.selectedIds[i];if(p?.generatedAt&&p.generatedAt!==run.baseline[id]&&p.tasteProfileHash===run.tasteProfileHash&&p.predictionPromptVersion===run.predictionPromptVersion){run.baseline[id]?recalculated++:created++;if(!['created','recalculated'].includes(run.results?.[id]))run.results[id]=run.baseline[id]?'recalculated':'created';}else if(!run.failures[id]&&!freshness.state(p,s.fingerprint,source[id]?.genres,id)&&!SETTLED_STATUSES.includes(run.results?.[id]))pending++;}
 created=Object.values(run.results).filter(x=>x==='created').length;recalculated=Object.values(run.results).filter(x=>x==='recalculated').length;const failed=Object.keys(run.failures).length;run.counts={created,recalculated,failed,pending};run.reason=['queue_empty','eligible_queue_empty','parse_error','manifest_spent'].includes(body.reason)?null:safePredictionReason(body.reason||run.interruption);run.reason=run.systemicStopReason||run.reason;run.stopReason=run.reason||(failed?'eligible_queue_empty':pending?'external_termination':'queue_empty');run.status=pending||run.reason?'partial':'complete';run.completedAt=new Date().toISOString();
 const summary=runSummary(run);let hotRemaining=null,coldRemaining=null,remaining=pending;
 if(run.mode==='queued'){
  // Retries, the batch summary and the counter go into the rebuild's own conditional write; the counter moves once per run.
  const amend=queue=>{recordRunRetries(queue,run);if(queue.lastBatch?.runId!==run.runId)queue.metrics.hotProcessedTotal+=summary.hotProcessed;queue.lastBatch={runId:run.runId,trigger:run.trigger,startedAt:run.createdAt,finishedAt:run.completedAt,stage:run.status,profileVersion:run.tasteProfileVersion,batchSize:run.batchSize,hotProcessed:summary.hotProcessed,coldProcessed:summary.coldProcessed,checked:summary.checked,added:created,updated:recalculated,failed,remaining:queue.pending.length,hotRemaining:queue.priorityCount,coldRemaining:queue.coldRemaining,reason:run.reason||(body.reason==='manifest_spent'?'manifest_spent':null),perFilmMs:created+recalculated?(Date.parse(run.completedAt)-Date.parse(run.createdAt))/(created+recalculated):null};queue.lastCheckAt=run.completedAt;return queue;};
  const succeeded=Object.entries(run.results||{}).filter(([,status])=>SETTLED_STATUSES.includes(status)).map(([id])=>id);let queue;try{queue=await atStage('queue_refresh',async()=>{const report=await loadJSON(env,'programme.json'),stored=await currentPredictionQueue(env,report,profile,'batch_complete');if(!stored)return null;const context=await advanceContext(env,report,profile,stored);
   // Under the gate on the queue this write actually mutates: a queue rebuilt for another generation meanwhile keeps its own settlement, `lastBatch` and counters; only this run's retries (which only grow) are added to it.
   return await mutatePredictionQueue(env,current=>{if(queueAdvanceGate(current,report,profile,context.registry)||settlementGenerationRefused(current,context))return recordRunRetries(current,run)?current:null;settleQueueFilms(current,succeeded);current.trigger='batch_complete';return amend(current);},'batch_complete',stored);});}catch(error){const held=catalogHeldQueueError(error);if(held)return ownedCatalogHeld('complete',held,requestId,run.runId);throw error;}if(queue)delete run.retryHeal;remaining=queue?.pending.length??pending;hotRemaining=queue?.priorityCount??null;coldRemaining=queue?.coldRemaining??null;
  // A normal completion is "drained" only when the refreshed queue has no outstanding film; otherwise work remains that
  // this run could not take (deferred by retry or waiting behind hot). Run completion and a drained queue stay separate.
  // ADR 0136: a short batch that spent its selected manifest records stopReason manifest_spent (not time_budget, not a false queue_empty) while still reporting the real global outstanding counters.
  if(queue&&!run.reason&&!pending)run.stopReason=body.reason==='manifest_spent'?'manifest_spent':(queue.priorityCount+queue.coldRemaining?'eligible_queue_empty':'queue_empty');
 }
 applyRetrySnapshot(run,run.mode==='queued'?await loadJSON(env,predictionQueueKey):null);
 await recoverBatchEventFilms(env,run,source,states);
 const snapshot=await predictionEventSnapshot(env,run.mode==='queued'?await loadJSON(env,predictionQueueKey):null,run.batchSize),delta=predictionEventDelta(run,summary,snapshot),v2=batchV2EventFields(run),failedCount=run.counts.failed||0,title=v2.presentation?(run.status==='complete'?(failedCount?'Пакет прогнозов обработан с ошибками':'Пакет прогнозов обработан'):'Пакет прогнозов прерван'):undefined,event=withBatchV2EventDetails({id:'enrichment-'+run.runId,type:'enrichment',at:run.completedAt,...run.counts,checked:summary.checked,added:created,updated:recalculated,batchSize:run.batchSize,...(run.manifestSize!==undefined?{manifestSize:run.manifestSize}:{}),selectedCount:run.selectedIds.length,hotProcessed:summary.hotProcessed,coldProcessed:summary.coldProcessed,remaining,hotRemaining,coldRemaining,queueSchemaVersion:6,batchCount:run.batchCount,batchesProcessed:predictionBatchesProcessed(run),delta,snapshot,lastHeartbeatAt:run.lastHeartbeatAt,stopReason:run.stopReason,trigger:run.trigger,stage:run.status,reason:run.reason,protocol:run.protocol||null,...(title?{title}:{}),...v2,...scheduledRunFields()},run,source);run.event=event;
 await timedStage(env,'terminal_event',async()=>{
  // ADR 0194 decision 6: with the outbox in D1 the run's completion and its terminal Event's outbox row are ONE batch; an admission failure fails the completion (the caller repeats it) instead of being swallowed.
  const aux=isBatchV2Run(run)?await auxAuthority(env):null;
  if(aux){
   const admission=await PredictionAux.outboxAdmission(aux,{kind:'stop',identity:run.runId,event,journalKey:auxJournalKey(event),runId:run.runId,writer:env?.[WRITER_OWNER]||null});
   await savePredictionRun({...env,[COMMIT_EXTRA_KEY]:{runId:run.runId,pre:[PredictionAux.runNotSupersededGuard(run.runId)],statements:admission.statements}},run);
   await auxFlushRow(env,aux,await PredictionAux.readOutboxRow(auxDb(env),admission.eventKey));
  }else{await savePredictionRun(env,run);if(isBatchV2Run(run))await parkAndFlushRunEvent(env,event,run.runId);else await writeEvent(env,event);}
 });
 await runnerLease(env,run.runId,'release');await settleExpiredDiagnostics(env);return json({runId:run.runId,status:run.status,counts:run.counts,...event});
}
async function enrichmentStatus(env){const recent=(await diagnosticHistory(env,20)).runs;const [profile,run,report,queue,discoveryRead,lease,eventOutbox]=await Promise.all([loadJSON(env,profileKey),loadJSON(env,ENRICHMENT_KEY+'latest-run.json'),loadJSON(env,'programme.json'),queueStatus(env),loadJSON(env,'epg/discovery-status.json').then(value=>({value}),()=>({value:null,unavailable:true})),loadJSON(env,RUNNER_LEASE_KEY),eventOutboxStatus(env)]);const summary=run?runSummary(run):null,state=run?.status==='running'?(lease?.runId===run.runId&&lease.expiresAt>Date.now()?'running':'blocked'):run?.status==='partial'?'blocked':run?.status==='complete'?'completed':'idle',live={state,runId:run?.runId||null,startedAt:run?.createdAt||null,lastHeartbeatAt:state==='running'&&lease&&lease.runId===run?.runId?lease.heartbeatAt:run?.lastHeartbeatAt||null,added:summary?.added||0,failed:summary?.failed||0,hotRemaining:queue?.hotRemaining??null,coldRemaining:queue?.coldRemaining??null,currentBatchSize:state==='running'?run.batchSize??null:null};return {...live,diagnostics:compactDiagnostics(recent.find(row=>row.runId===run?.runId)||recent[0]||null),live,currentRun:state==='running'?live:null,recentRuns:recent.filter(r=>r.state!=='running').slice(0,10),profileVersion:profile?.version||null,fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,fingerprintPromptVersion:FINGERPRINT_PROMPT_VERSION,predictionPromptVersion:PREDICTION_PROMPT_VERSION,compatibility:{profileMode:PREDICTION_PROFILE_MODE,fingerprintMode:PREDICTION_FINGERPRINT_MODE},lastRun:run?{...runSummary(run),counts:run.counts||null,failures:run.failures,reason:run.reason||null,completedAt:run.completedAt||null}:null,selectedCount:queue?(queue.hotCount||0)+(queue.coldCount||0):report?eligibleEnrichmentFilms(report).length:0,pendingCount:queue?.pendingCount??null,discovery:discoveryRead.value||null,...(discoveryRead.unavailable?{discoveryStatus:'unavailable'}:{}),queue,eventOutbox};}
// AIR-586. The view needs a catalog film only for `allEnrichmentFilms` (its id, its TMDB identity and the policy verdict) and the freshness rule (`indexed`
// reads `id` and `genres`). The verdict is taken on the whole stored film, a film it excludes is left out, and the rest keep `id`, `tmdbId`, `genres` and
// `genreIds`: on those fields alone the policy can only answer what it answered on the whole film or a verdict that does not exclude (documentary is decided
// by the genres, concert needs a title, an overview or a category), so `allEnrichmentFilms` keeps exactly the films it kept before.
const GENRE_CATALOG_PROJECTION={project:film=>{
 if(!film||typeof film!=='object')return film;
 if(policyExcludedEnrichmentFilm(film))return undefined;
 const out={id:film.id,tmdbId:film.tmdbId};
 if(Object.hasOwn(film,'genres'))out.genres=film.genres;
 if(Object.hasOwn(film,'genreIds'))out.genreIds=film.genreIds;
 return out;
}};
function projectGenreCatalog(catalog){
 if(!catalog||typeof catalog!=='object'||Array.isArray(catalog))return catalog;
 const out={};
 for(const [id,film] of Object.entries(catalog)){const value=GENRE_CATALOG_PROJECTION.project(film);if(value!==undefined)out[id]=value;}
 return out;
}
async function loadGenreCatalog(env){
 if(typeof DiscoveryAuthority!=='undefined'){
  const gate=await DiscoveryAuthority.readAuthority(env);
  if(gate.held){const error=new Error('discovery_fence');error.code='discovery_fence';throw error;}
  if(gate.ready){
   const routed=await DiscoveryAuthority.routeRead(env,'epg/discovered-films.json',GENRE_CATALOG_PROJECTION);
   if(!routed.handled){const error=new Error('discovery_unavailable');error.code='discovery_unavailable';throw error;}
   return routed.value;
  }
 }
 return projectGenreCatalog(await loadJSON(env,'epg/discovered-films.json'));
}
async function enrichmentView(env){const [profile,stored]=await Promise.all([loadJSON(env,profileKey),readViewIndex(env)]),index=stored,freshness=await predictionFreshness(env,profile);
 // Genres feed only the selective rules, so the programme and catalog are read only when one of them is on.
 const films=freshness.needsGenres?await (async()=>{const pinned=await pinEpg(env),[report,catalog]=await Promise.all([loadJSON(pinned,'programme.json'),loadGenreCatalog(pinned)]);return new Map(allEnrichmentFilms(report||{films:[]},catalog).map(f=>[String(f.id),f]));})():null;return {moodVocabulary:{version:MOOD_MAPPING_VERSION,labels:MOOD_LABELS,groups:MOOD_GROUPS},profile:profile?{version:profile.version,updatedAt:profile.updatedAt}:null,compatibility:{profileMode:freshness.mode,fingerprintMode:freshness.fingerprintMode,...fingerprintTarget()},films:Object.fromEntries(Object.entries(index||{}).map(([id,item])=>{const p=item.prediction,f=item.fingerprint,facet=canonicalMoodFacet(f,p);return [id,{moodIds:facet.moodIds,moodGroups:moodPresentationGroups(facet.mapping),fingerprint:f&&f.fingerprintHash===item.fingerprintHash?{plotMechanics:f.plotMechanics||[],moodIds:facet.moodIds,execution:executionFacet(f.execution)}:null,prediction:p?{predictedRating:p.predictedRating,probability4Plus:p.probability4Plus,confidence:p.confidence,matchSignals:p.matchSignals,mainRisk:p.mainRisk,moodIds:facet.moodIds,...(Object.hasOwn(p,'confidenceAssessment')?{confidenceAssessment:p.confidenceAssessment,fingerprintHash:p.fingerprintHash??null}:{}),stale:!freshness.indexed(item,films?.get(id))}:null,actualRating:item.actualRating??null,watched:item.watched===true?true:item.watched===false?false:null}];}))};}

const predictionBenchmarkKey=id=>ENRICHMENT_KEY+'benchmarks/'+encodeURIComponent(id)+'.json';
async function predictionBenchmarkStart(env){
 const [profile,index,report,catalog]=await Promise.all([loadJSON(env,profileKey),loadJSON(env,ENRICHMENT_KEY+'view-index.json'),loadJSON(env,'programme.json'),loadJSON(env,'epg/discovered-films.json')]);if(!profile)return json({error:'No profile'},409);
 const films=new Map(allEnrichmentFilms(report||{films:[]},catalog).map(f=>[String(f.id),f])),candidates=Object.entries(index||{}).filter(([,item])=>indexedPredictionCurrent(item,profile)).sort(([a],[b])=>a.localeCompare(b,'en')).slice(0,80),sample=[],references={};
 for(const [id] of candidates){const state=await readFilmState(env,id);if(!fingerprintCurrent(state.fingerprint)||!predictionCurrent(state.predictions?.current,profile,state.fingerprint))continue;sample.push({filmId:id,fingerprint:state.fingerprint,...(films.has(id)?{metadata:modelMetadata(films.get(id))}:{})});references[id]=state.predictions.current;if(sample.length===20)break;}
 if(sample.length<20)return json({error:'Need 20 existing current fingerprints/predictions for the isolated benchmark'},409);
 const benchmark={benchmarkId:crypto.randomUUID(),createdAt:new Date().toISOString(),profileVersion:profile.version,profileHash:profile.profileHash,profile:profile.profile,fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,predictionPromptVersion:PREDICTION_PROMPT_VERSION,sample,references,trials:[],productionBatchingEnabled:false};await saveJSON(env,predictionBenchmarkKey(benchmark.benchmarkId),benchmark);
 return json({benchmarkId:benchmark.benchmarkId,profile:benchmark.profile,profileVersion:benchmark.profileVersion,profileHash:benchmark.profileHash,items:sample,sizes:[4,8,12,20],rules:['Shadow benchmark only: never send trial outputs to a prediction submit.','For each size, use the identical full taste profile/scoring instructions and first size saved fingerprints. Return a JSON array of {filmId,prediction}; no regeneration of fingerprints.','Record real model input/output tokens and elapsedMs if available. Missing telemetry remains null, never estimated as measured usage.','Existing predictions are held out as comparability references, not real outcome truth. Qualitative matchSignals/mainRisk review is required.']});
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
// `indexNow: false` (AIR-442) leaves the view-index entry to the caller, which must write it or flush `fingerprintIndexPatch(value)`; `submit` does, so one film costs one index read and write.
const fingerprintIndexPatch=value=>({fingerprintHash:value.fingerprintHash,fingerprint:fingerprintFacet(value),impactFeatures:fingerprintImpactFacet(value)});
async function writeFingerprint(env,id,content,previous,produced,fields,promptVersion=FINGERPRINT_PROMPT_VERSION){
 const at=new Date().toISOString(),body={...content,filmId:id};body.fingerprintHash=await contentHash({...content,filmId:id});
 const value={...body,generatedAt:at,invalidatedAt:null,fingerprintPromptVersion:promptVersion,produced,...(fields?{fields}:{}),previous:fingerprintIdentity(previous)};
 await putCreateOnly(env,fingerprintBodyKey(id,body.fingerprintHash),body);
 const record={filmId:id,...fingerprintIdentity(value),generatedAt:at,produced,...(fields?{fields}:{}),previous:value.previous};
 await putCreateOnly(env,fingerprintGenerationKey(id,record),record,stored=>generationRecordAcceptable(env,stored,record));
 await saveJSON(env,filmKey(id)+'fingerprint.json',value);
 return value;
}
// The stored generation records of a film with their bodies, newest first; empty for a film whose fingerprints predate the writer. The whole prefix is
// read page by page up to FINGERPRINT_GENERATION_SCAN_LIMIT records; a longer history is a storage error, never "no candidate".
const FINGERPRINT_GENERATION_SCAN_LIMIT=1000;
// Write-once: the key carries the checksum, so an existing object must hold the same bytes. Anything else is a storage conflict and the bundle is left unchanged.
// ADR 0132: the assessment sidecar. One immutable object per prediction version, created only, written after the version object and before the guarded D1 commit.
// A request is told apart by the checksum of the canonical caller assessment; the Worker confirms the lineage fields and keeps everything the caller said under callerReported.
async function assessmentSha256(assessment){return contentHash(assessment);}
function predictionAssessmentKey(filmId,predictionSha256){return 'enrichment/films/'+encodeURIComponent(String(filmId))+'/predictions/assessments/'+predictionSha256+'.json';}
class AssessmentConflict extends Error{}
async function writePredictionAssessment(env,filmId,pointer,confirmed,assessment){
 const sha=await assessmentSha256(assessment),key=predictionAssessmentKey(filmId,pointer.contentSha256);
 const {research,sources,conflicts,model,assessmentVersion,...own}=assessment;
 const body={objectVersion:1,filmId:String(filmId),predictionSha256:pointer.contentSha256,predictionKey:pointer.r2Key,confirmed:{...confirmed,assessmentSha256:sha},callerReported:{model,research,sources,conflicts},assessment:{assessmentVersion,...own}};
 const saved=await env.BUCKET.put(key,JSON.stringify(body),{httpMetadata:{contentType:'application/json'},onlyIf:{etagDoesNotMatch:'*'}});
 if(saved!==null)return 'written';
 const existing=await env.BUCKET.get(key),text=existing?await existing.text():null;let stored=null;try{stored=text?JSON.parse(text):null;}catch{stored=null;}
 if(stored?.confirmed?.assessmentSha256!==sha||stored?.predictionSha256!==pointer.contentSha256)throw new AssessmentConflict('Prediction assessment object conflicts');
 return 'present';
}
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
function overlayRatingsSeed(index){
 const next=cloneJSON(index||{});
 applyRatingsSeed(next);
 return next;
}
async function readViewIndex(env){
 return overlayRatingsSeed(await loadJSON(env,ENRICHMENT_KEY+'view-index.json'));
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
// prediction bundle, the film's Letterboxd fact record through the link index, the legacy rating log, the profile, the
// Diary history and its run state, plus one read per immutable version object on the requested page. Never a write, a
// model call, a Letterboxd request, a refresh or a lease.
// AIR-475: the storage ids a Film's predictions can lie under besides the requested spelling (a canonical /film/tmdb_<n> page asks with tmdb_<n>, the versions may be stored under
// the trusted Letterboxd lid and the other way round). Only while the Film/Person marker is open, only through the D1 identity claims (src/canonical-catalog-reader.js), never a
// title, year or slug. An unreadable or held marker is {state:'unavailable'}; before open the route keeps reading the requested id alone ({state:'not_open'}).
async function filmHistoryBridge(env,filmId){
 const reader=typeof CanonicalCatalogReader==='undefined'?null:CanonicalCatalogReader;
 if(!reader)return {state:'not_open',ids:[],lid:null};
 try{
  const gate=await reader.catalogReaderGate(env);
  if(gate.mode!=='d1')return {state:'not_open',ids:[],lid:null};
  const found=await reader.catalogFilmIdentityBridge(env,filmId);
  if(found.state!=='ok')return {state:found.state,ids:[],lid:null,gate};
  return {state:'ok',gate,ids:[...new Set([...(found.lid?[found.lid]:[]),...(found.tmdb?['tmdb_'+found.tmdb]:[])])].filter(id=>id!==filmId),lid:found.lid};
 }catch(error){return {state:'unavailable',ids:[],lid:null,reason:error?.code||'identity_unavailable'};}
}
// AIR-475 review: every MUTABLE source of the history is read through its own authority, never from a frozen R2 copy. The Letterboxd facts (`links.json`, `films/<factKey>.json`) and the Diary
// (`history.json`, `state.json`) belong to RatingsD1 and the prediction bundles and the taste profile to PredictionD1: while that domain is d1 and open its D1 documents are the source, a held
// d1 domain is a refusal (`ratings_domain_not_authoritative`), and an unreadable one a typed `ratings_*` / `prediction_*` error (503), never a fall back to the R2 object (a stale mirror).
// Only where a domain is not d1 (or absent, as in local stand-ins) is the R2 object read. The etag of a D1 read is its document etag, so a cursor digest covers it. Immutable version
// bodies and the legacy rating log are not owned by either domain and stay R2.
async function readFilmHistorySource(env,key,readR2){
 if(typeof RatingsD1!=='undefined'&&RatingsD1.ratingsMutableKey(key)){
  const authority=await RatingsD1.readRatingsAuthority(env?.DB,env);
  if(authority.tables&&authority.mode==='d1'&&!authority.ready){const error=new Error('ratings_domain_not_authoritative');error.code='ratings_domain_not_authoritative';throw error;}
  if(authority.ready){
   const owned=await RatingsD1.readOwned(env,key);
   return owned.value==null?{status:'missing',etag:null,value:null}:{status:'recorded',etag:'d1:'+owned.etag,value:owned.value};
  }
 }
 if(typeof PredictionD1!=='undefined'){
  const routed=await PredictionD1.routeRead(env,key);
  if(routed.handled)return routed.value?{status:'recorded',etag:'d1:'+await textSha256(JSON.stringify(routed.value)),value:routed.value}:{status:'missing',etag:null,value:null};
 }
 return readR2(key);
}
// A typed domain error is a 503, never a partial answer built from a copy the domain does not own.
async function filmHistoryRoute(env,url){
 try{return await filmHistoryRouteRead(env,url);}
 catch(error){
  const code=String(error?.code||'');
  if(code.startsWith('prediction_'))return json({error:'prediction_unavailable',reason:code},503);
  if(code.startsWith('ratings_'))return json({error:'ratings_unavailable',reason:code},503);
  throw error;
 }
}
async function filmHistoryRouteRead(env,url){
 const filmId=url.searchParams.get('filmId');
 if(typeof filmId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(filmId))return json({error:'filmId must be 1–80 letters, digits, "_" or "-"'},400);
 const page=filmHistoryPageRequest(url.searchParams);if(page.error)return json({error:page.error},400);
 const readR2=async key=>{const object=await env.BUCKET.get(key);if(!object)return {status:'missing',etag:null,value:null};try{return {status:'recorded',etag:object.etag,value:await object.json()};}catch{return {status:'unreadable',etag:object.etag,value:null};}};
 const read=key=>readFilmHistorySource(env,key,readR2);
 const bundle=await read(filmKey(filmId)+'predictions.json');
 const tmdb=/^tmdb_([1-9]\d{0,11})$/.exec(filmId),alias=tmdb?'tmdb:'+tmdb[1]:'letterboxd:'+filmId;
 // A canonical tmdb_<n> permalink cannot be answered from the requested id alone while the identity cannot be verified: 503, never an empty history that reads as "nothing recorded".
 const bridge=await filmHistoryBridge(env,filmId);
 if(tmdb&&bridge.state==='unavailable')return json({error:'identity_unavailable',reason:bridge.reason},503);
 const extra=[];
 for(const id of bridge.ids)extra.push({id,bundle:await read(filmKey(id)+'predictions.json')});
 const links=await read(LetterboxdFacts.FACTS_KEYS.links);
 let factKey=links.value?.[alias]||null,fact={status:'missing',etag:null,value:null};
 // Diary lid candidates: the requested id when it is a lid, and the lid of every fact record read (both sides of a convergence).
 const lidCandidates=tmdb?[]:[{lid:filmId,via:'requested_id'}];
 if(factKey){
  fact=await read(LetterboxdFacts.recordKey(factKey));
  if(fact.value?.redirectTo){factKey=fact.value.redirectTo;fact=await read(LetterboxdFacts.recordKey(factKey));}
  else if(fact.value?.migrating?.to){const target=await read(LetterboxdFacts.recordKey(fact.value.migrating.to));lidCandidates.push({lid:fact.value.links?.letterboxd,via:'fact_record'});fact={status:fact.status,etag:fact.etag+'+'+target.etag,value:LetterboxdFacts.overlay(fact.value,target.value)};}
 }
 const factLinks=fact.value?.links||{},filmIds=[...new Set([filmId,...bridge.ids,...(factLinks.letterboxd?[String(factLinks.letterboxd)]:[]),...(factLinks.tmdb?['tmdb_'+factLinks.tmdb]:[])])];
 if(factLinks.letterboxd)lidCandidates.push({lid:String(factLinks.letterboxd),via:'fact_record'});
 if(bridge.lid)lidCandidates.push({lid:bridge.lid,via:'d1_identity'});
 const [legacy,profile,diaryHistory,diaryState]=await Promise.all([read(ratingObservationsKey),read(profileKey),read(LetterboxdDiary.KEYS.history),read(LetterboxdDiary.KEYS.state)]);
 // The Diary history joins the digest only once it exists, so cursors of a film without one keep their earlier form.
 const digest=(await textSha256([bundle.etag,...extra.map(item=>item.bundle.etag),fact.etag,legacy.etag,...(diaryHistory.status==='missing'?[]:[diaryHistory.etag])].map(value=>value||'-').join('|'))).slice(0,16);
 if(page.digest&&page.digest!==digest)return json({error:'history_changed',detail:'The stored history changed since this cursor was issued; start again without a cursor.'},409);
 const link=diaryLink(lidCandidates);
 const built=buildFilmHistory({filmId,filmIds,bundle:bundle.value,factRecord:fact.value,legacyLog:legacy.value,profile:profile.value,diary:{history:diaryHistory.value,link}});
 if(diaryHistory.status!=='recorded')built.notes.push('diary_history_'+diaryHistory.status);
 const coverage=diaryState.value?.coverage||null,diaryComplete=diaryState.value?.lastOutcome==='complete'&&coverage?.reachedEnd===true&&!diaryState.value?.resumePage;
 if(diaryHistory.status==='recorded'&&!diaryComplete)built.notes.push('diary_coverage_partial');
 const diaryEntries=Object.values(diaryHistory.value?.entries||{});
 built.current.diary=link.status==='linked'&&diaryHistory.status==='recorded'?{lid:link.lid,...(LetterboxdDiary.summarize({entries:diaryEntries.filter(entry=>entry?.identity?.type==='letterboxd_lid'&&entry.identity.value===link.lid)})[link.lid]||{viewingCount:0,viewingCountExact:true,lastWatchedAt:null,rewatches:0,rewatchesExact:true})}:null;
 // The versions of the bridged storage ids join as prediction events of their own, identity-prefixed by the storage id so two bundles never collide; every version is checked against
 // the id it lies under. No version is regenerated, merged by content or matched by title.
 const records=new Map([...(Array.isArray(bundle.value?.history)?bundle.value.history:[]).map((record,i)=>['prediction|history|'+i,{record,holder:filmId}]),...(bundle.value?.current?[['prediction|current|0',{record:bundle.value.current,holder:filmId}]]:[])]);
 const currents=[{holder:filmId,prediction:built.current.prediction}];
 for(const {id,bundle:other} of extra){
  const part=buildFilmHistory({filmId:id,bundle:other.value,profile:profile.value});
  for(const event of part.events){const identity=id+'|'+event.identity;built.events.push({...event,identity,storageId:id});}
  for(const [identity,record] of [...(Array.isArray(other.value?.history)?other.value.history:[]).map((record,i)=>['prediction|history|'+i,record]),...(other.value?.current?[['prediction|current|0',other.value.current]]:[])])records.set(id+'|'+identity,{record,holder:id});
  for(const note of part.notes)if(!built.notes.includes(note))built.notes.push(note);
  if(part.current.prediction)currents.push({holder:id,prediction:part.current.prediction});
 }
 if(extra.length){
  built.events.sort(compareHistoryEvents);
  const live=currents.filter(item=>item.prediction),latest=live.reduce((best,item)=>!best||String(item.prediction.generatedAt||'')>String(best.prediction.generatedAt||'')?item:best,null);
  if(live.length>1)built.notes.push('prediction_current_in_several_storage_ids');
  built.current.prediction=latest?(latest.holder===filmId?latest.prediction:{...latest.prediction,storageId:latest.holder}):null;
 }
 if(bridge.state==='conflict'||bridge.state==='retired'||bridge.state==='unavailable')built.notes.push('identity_bridge_'+bridge.state);
 const slice=built.events.slice(page.offset,page.offset+page.limit);
 for(const event of slice){
  if(event.type!=='prediction')continue;
  const held=records.get(event.identity),record=held?.record;
  if(!record?.r2Key&&!record?.contentSha256)continue;
  if(!predictionVersionLinked(record,held.holder)){event.version={status:'invalid',r2Key:historyValue(record,'r2Key'),contentSha256:historyValue(record,'contentSha256')};continue;}
  const object=await env.BUCKET.get(record.r2Key);
  const status=!object?'missing':await textSha256(await object.text())===record.contentSha256?'linked':'mismatch';
  event.version={status,r2Key:record.r2Key,contentSha256:record.contentSha256};
 }
 const partial=[bundle,...extra.map(item=>item.bundle),fact,legacy,diaryHistory].some(source=>source.status==='unreadable')||bridge.state==='unavailable'||slice.some(event=>event.type==='prediction'&&['missing','mismatch','invalid'].includes(event.version.status));
 const next=page.offset+page.limit<built.events.length?String(page.offset+page.limit)+'.'+digest:null;
 // AIR-475 review: the identity the bridge verified must still hold when the answer leaves. Every read above (bundles, facts, Diary, legacy log, immutable objects) ran after the bridge,
 // so the marker is read again: a canonical permalink or any answer that joined bridged ids is refused (503) if the state or generation moved; a lid answer that joined nothing keeps its partial policy.
 let identityMoved=false;
 if(bridge.gate){
  let moved=null;
  try{await CanonicalCatalogReader.catalogReaderStill(env,bridge.gate);}catch(error){moved=error;}
  if(moved){
   if(tmdb||bridge.ids.length)return json({error:'identity_unavailable',reason:moved.code||'film_person_generation_moved'},503);
   built.notes.push('identity_bridge_unavailable');
   identityMoved=true;
  }
 }
 return json({schemaVersion:FILM_HISTORY_SCHEMA_VERSION,filmId,readAt:new Date().toISOString(),
  snapshot:{profile:profile.value?{version:profile.value.version??null,profileHash:profile.value.profileHash??null}:null,...(bridge.state==='not_open'?{}:{identity:identityMoved?{state:'unavailable',storageIds:[]}:{state:bridge.state,storageIds:bridge.ids}}),sources:{predictions:{status:bundle.status,...(extra.length?{bridged:extra.map(item=>({id:item.id,status:item.bundle.status}))}:{})},facts:{status:factKey?fact.status:'missing',factKey},legacyRatingLog:{status:legacy.status},
   diary:{status:diaryHistory.status,link,unresolvedEntries:diaryEntries.filter(entry=>!entry?.identity).length,
    state:diaryState.value?{lastOutcome:diaryState.value.lastOutcome??null,lastSuccessAt:diaryState.value.lastSuccessAt??null,coverage,resumePage:diaryState.value.resumePage??null}:null}}},
  current:built.current,partial:partial||identityMoved,notes:built.notes,events:slice,page:{limit:page.limit,offset:page.offset,total:built.events.length,nextCursor:next}});
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
  const old=await loadJSON(pinned,'epg/discovery-latest.json'),items=mergeDiscoveryCandidates(old?.items,result.discovery,{replaceShows:true,programmeRunId:report.runId});const replaced=replaceCatalogAvailability(cache,result.discovery,report.runId,{writeAvailability:pinned?.epgPin?.authority!=='d1'});
  await updatePublishedFiles(env,{'discovery-latest.json':{programmeRunId:report.runId,updatedAt:new Date(now).toISOString(),rawCandidates:result.stats.rawCandidates,filteredNonMovies:result.stats.filteredNonMovies,items},'discovered-films.json':replaced.catalog});
  await refreshPredictionQueue(env,report,'epg_scan');const presented=await presentQueuedDiscovery(env,await queueDiscovery(env,'scan_committed',report.runId));return json({programmeRunId:report.runId,candidates:items.length,newCandidates:items.length-(old?.items?.length||0),scanned:result.stats.scanned,...presented});
 }
 if(['/api/enrichment/discovery/status','/api/enrichment/pipeline/status'].includes(path)&&request.method==='GET'){
  // AIR-430: `view=operational` is the light status (small records only, no ledger scan); no `view` or `view=detailed` is the unchanged full status.
  const view=url.searchParams.get('view');
  if(view!==null&&!['operational','detailed'].includes(view))return json({error:'Invalid view',allowed:['operational','detailed']},400);
  return json(view==='operational'?await discoveryOperationalStatus(env):await discoveryPipelineStatus(env));
 }
 // Read-only audit export. No lazy rating initialization, source fetch, or enrichment generation.
 if(path==='/api/enrichment/diagnostics/export'&&request.method==='GET'){
  const group=url.searchParams.get('group')||'global';
  if(group==='global'){
  try{
   const keys=['enrichment/diagnostics/baseline.json','enrichment/diagnostics/rating-observations.json','enrichment/profile/current.json','epg/discovered-films.json','programme.json','watchlist.json','metadata.json','titles.json'];
   const filmPersonGate=typeof CanonicalCatalogReader==='undefined'?null:await CanonicalCatalogReader.catalogReaderGate(env);
   const frozen=new Set(['metadata.json','titles.json']);
   const records=await Promise.all(keys.map(async key=>{
    if(filmPersonGate?.mode==='d1'&&frozen.has(key))return {key,uploadedAt:null,etag:'d1:'+filmPersonGate.generation,value:null};
    const object=await env.BUCKET.get(key);
    return {key,uploadedAt:object?.uploaded?.toISOString?.()||null,etag:object?.etag||null,value:object?await object.json():null};
   }));
   if(filmPersonGate?.mode==='d1'){
    const wanted=canonicalIdentityIds(records.filter(item=>item.value&&!frozen.has(item.key)).map(item=>item.value));
    const meta=await CanonicalCatalogReader.catalogMetadataFromD1(env,wanted,filmPersonGate);
    const titles=await CanonicalCatalogReader.catalogTitlesFromD1(env,wanted.map(id=>({id,tmdbId:meta[id]?.tmdbId})),filmPersonGate);
    for(const item of records){
     if(item.key==='metadata.json')item.value=meta;
     if(item.key==='titles.json')item.value=titles;
    }
   }
   if(filmPersonGate)await CanonicalCatalogReader.catalogReaderStill(env,filmPersonGate);
   return json({exportedAt:new Date().toISOString(),group,records});
  }catch(error){const refused=canonicalCatalogReadRefusal(error);if(refused)return refused;throw error;}
 }
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
 if(path==='/api/enrichment/heartbeat'&&request.method==='POST')return timedBatchStep(env,'batch_heartbeat',body,requestId,timed=>taskOwnerGate(timed,body,()=>observedPrediction(timed,body,()=>predictionWriter(timed,()=>runnerHeartbeat(timed,body)),'heartbeat',requestId)));
 // batchSubmit takes the gate, then the step recorder and the writer lease, for a real call; a dry run takes none of them and writes nothing at all.
 if(path==='/api/enrichment/batch/submit'&&request.method==='POST')return timedBatchStep(env,'batch_submit',body,requestId,async timed=>(body?.dryRun===true?null:await auxClosedRefusal(timed))||batchSubmit(timed,body,requestId));
 if(path==='/api/enrichment/batch/hold'&&request.method==='POST')return timedBatchStep(env,'batch_hold',body,requestId,async timed=>(await auxClosedRefusal(timed))||batchHold(timed,body));
 if(path==='/api/enrichment/batch/start'&&request.method==='POST')return timedBatchStep(env,'batch_start',body,requestId,async timed=>(body?.dryRun===true?null:await auxClosedRefusal(timed))||batchStartRoute(timed,body,requestId));
 if(path==='/api/enrichment/runs'&&request.method==='GET'){const text=url.searchParams.get('limit')||'10';if(!/^\d+$/.test(text)||Number(text)<1||Number(text)>100)return json({error:'Invalid limit (1–100)'},400);return json(await diagnosticHistory(env,Number(text)));}
 if(path==='/api/enrichment/queue/reconcile'&&request.method==='POST'){const report=await loadJSON(env,'programme.json');let queue;try{queue=await refreshPredictionQueue(env,report,'manual_reconcile');}catch(e){if(e?.name==='PredictionQueueConflictError')return json({error:'Prediction queue changed during write; read it again',code:e.code},409);throw e;}return queue?json(await queueStatus(env)):json({error:'Programme or taste profile unavailable'},409);}
 if(path==='/api/enrichment/queue/status'&&request.method==='GET')return json(await queueStatus(env)||{status:'not_initialized',pendingCount:null,...scheduledRunFields()});
 if(path==='/api/enrichment/footer/status'&&request.method==='GET'){
  try{return json(await footerStatus(env));}
  catch(error){const refused=canonicalCatalogReadRefusal(error);if(refused)return refused;throw error;}
 }
 if(path==='/api/enrichment/complete'&&request.method==='POST')return timedBatchStep(env,'batch_complete',body,requestId,async timed=>(await auxClosedRefusal(timed))||taskOwnerGate(timed,body,()=>observedPrediction(timed,body,()=>predictionWriter(timed,owned=>enrichmentComplete(owned,body,requestId)),'complete',requestId)));
 if(path==='/api/enrichment/status'&&request.method==='GET')return json(await enrichmentStatus(env));
 if(path==='/api/enrichment/moods/diagnostics'&&request.method==='GET')return json(moodDiagnostics(await loadJSON(env,ENRICHMENT_KEY+'view-index.json')));
 if(path==='/api/enrichment/schema'&&request.method==='GET')return json(enrichmentSchemaDocument());
 if(path==='/api/enrichment/view'&&request.method==='GET'){
  try{return json(await enrichmentView(env));}
  catch(error){
   if(['discovery_fence','discovery_incomplete','discovery_unavailable','discovery_not_authoritative','discovery_bounded'].includes(error?.code)){
    return json({error:'The catalog is not readable right now',code:error.code},503,{'Retry-After':'1'});
   }
   throw error;
  }
 }
 if(path==='/api/enrichment/actual-ratings'&&request.method==='PUT'){if(!Array.isArray(body.items)||body.items.length>100)return json({error:'Expected items (max 100)'},400);const results=[];for(const item of body.items){const id=String(item?.filmId||''),rating=item?.rating;if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id)||!(rating===null||Number.isFinite(rating)&&rating>=.5&&rating<=5&&rating*2%1===0)){results.push({filmId:id,error:'Invalid film or rating'});continue;}const updatedAt=new Date().toISOString();const facts=await LetterboxdFacts.recordFilmFacts(env,id,{rating},{observedAt:updatedAt,source:'owner'});if(facts.conflict){results.push({filmId:id,error:'Identity conflict; recorded for review'});continue;}if(!facts.accepted||facts.record.rating?.value!==rating){results.push({filmId:id,status:'older',rating:facts.record.rating?.value??null});continue;}await saveActualMirror(env,filmKey(id)+'actual.json',{rating,source:'letterboxd',updatedAt});results.push({filmId:id,status:'saved'});}return json({results});}
 if(path==='/api/enrichment/ratings/backfill'&&request.method==='POST')return ratingsBackfill(env,body);
 return json({error:'Not found'},404);
}
