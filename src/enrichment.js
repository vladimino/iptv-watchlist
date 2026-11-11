
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
 let moved,settled=false;
 try{moved=routed.handled?{etag:'d1'}:await env.BUCKET.put(profileKey,routed.text??JSON.stringify(value),{httpMetadata:{contentType:'application/json'},onlyIf:currentEtag?{etagMatches:currentEtag}:{etagDoesNotMatch:'*'}});settled=true;}
 finally{if(routed.token&&settled)await PredictionD1.completePredictionWrite(env,profileKey,routed.token);}
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
// so a caller can run the same checks before prediction_submit. Every rule value is a constant
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
 aggregate:{order:['plotMechanics','generalExecution','genreExecution'],basis:'first-seen unique bases in that order; one basis keeps its name and more than one is mixed',refs:'first-seen unique refs in that order, capped at sourceRefCap'},
 metadataPreflight:'prediction_validate accepts optional metadata, the film modelMetadata, only when evidence cites a metadata token. The tool reads no storage. Submit uses the modelMetadata stored for the run. A metadata token whose fact is absent is invalid_ref.'
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
function evidenceIssues(fingerprint,metadata){
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
 if(fingerprint.sourceBasis!==(bases.length===1?bases[0]:'mixed'))add('fingerprint.sourceBasis','invalid_enum');
 const got=fingerprint.sourceRefs;
 if(!Array.isArray(got)||got.length!==refs.length||got.some((ref,index)=>ref!==refs[index]))add('fingerprint.sourceRefs','invalid_ref');
 return issues;
}
function fingerprintIssues(f,metadata){
 const issues=ruleIssues('fingerprint',FINGERPRINT_RULES,f);
 if(isObject(f)&&Object.hasOwn(f,'evidence')){
  // The rule table only knows https and model_knowledge. An evidence object may also cite the four metadata tokens,
  // so that one code is decided by the aggregate below instead of the table.
  if(isObject(f.evidence)){const kept=issues.filter(issue=>!(issue.path==='fingerprint.sourceRefs'&&issue.code==='invalid_ref'));issues.length=0;issues.push(...kept);}
  for(const issue of evidenceIssues(f,metadata)){if(issues.length>=MAX_ISSUES)break;if(!issues.some(have=>have.path===issue.path&&have.code===issue.code))issues.push(issue);}
 }
 if(isObject(f)&&!issues.length&&JSON.stringify(f).length>FINGERPRINT_MAX_CHARS)issues.push({path:'fingerprint',code:'too_large'});
 return issues;
}
function predictionIssues(p){return ruleIssues('prediction',PREDICTION_RULES,p);}
const issueText=issues=>issues.length?'Invalid '+issues.map(issue=>issue.path+' '+issue.code).join(', '):null;
function validateFingerprint(f){return issueText(fingerprintIssues(f));}
function validatePrediction(p){return issueText(predictionIssues(p));}
function schemaContract(){return {version:1,fingerprint:{rules:FINGERPRINT_RULES,maxChars:FINGERPRINT_MAX_CHARS,evidence:EVIDENCE_CONTRACT},prediction:{rules:PREDICTION_RULES},issueCodes:ISSUE_CODES,issuePath:'<fingerprint|prediction>[.<field>[.<dimension or evidence group>[.<claim>]]]; a list issue names the list, not the item',reportedVia:'POST /api/enrichment/submit results[].validation {stage, reportedBy, issues[]}'};}
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
async function mergeStoredJSON(env,key,empty,apply){
 if(typeof RatingsD1!=='undefined'&&RatingsD1.ratingsMutableKey(key)){try{const owned=await RatingsD1.casOwned(env,key,empty,async current=>apply(current));if(owned.owned)return owned.result.value;}catch(error){if(error.code==='write_contention')throw new Error('Stored JSON changed during write');throw error;}}
 for(let attempt=0;attempt<5;attempt++){
  const object=await env.BUCKET.get(key),current=object?await object.json():cloneJSON(empty),next=await apply(cloneJSON(current));
  if(next==null)return current;
  const saved=await env.BUCKET.put(key,JSON.stringify(next),{httpMetadata:{contentType:'application/json'},onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});
  if(saved!==null)return next;
 }
 throw new Error('Stored JSON changed during write');
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
// Writers that already mutate the view index persist a missing compiled seed. GET /api/enrichment/view overlays in memory and does not call this.
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
async function saveActualMirror(env,key,body){if(typeof RatingsD1!=='undefined'&&await RatingsD1.ratingsReady(env))return;await saveJSON(env,key,body);}
async function refreshPersonalRating(env,film){
 const id=String(film.id),match=String(film.url||'').match(/^https:\/\/letterboxd\.com\/film\/([a-z0-9-]+)\/$/);if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id)||!match)throw new Error('Invalid Letterboxd film identity');
 const username=sourceConfig(env).letterboxdUsername,sourceUrl=`https://letterboxd.com/${username}/film/${match[1]}/`,requestedAt=new Date().toISOString();let response;
 try{response=await fetch(sourceUrl,{headers:{'User-Agent':'Mozilla/5.0 (compatible; WatchlistAirtime/1.0)','Accept':'text/html'},signal:AbortSignal.timeout(15000)});}catch(e){throw new Error('Rating lookup failed: '+e.message);}
 if(response.status===404)return {filmId:id,status:'not_found'};if(!response.ok)throw new Error('Rating source HTTP '+response.status);
 const rating=parsePersonalRating(await response.text(),film.url,username);if(rating===null)return {filmId:id,status:'not_rated'};
 const facts=await LetterboxdFacts.recordFilmFacts(env,id,{watched:true,rating},{observedAt:requestedAt,source:'letterboxd_film_page',sourceRef:sourceUrl});if(facts.conflict)return {filmId:id,status:'identity_conflict'};const saved=facts.outcomes.some(o=>o.outcome==='new'||o.outcome==='replaces');if(saved&&facts.record.rating?.value===rating)await saveActualMirror(env,filmKey(id)+'actual.json',{rating,source:'letterboxd',sourceUrl,updatedAt:requestedAt});await enrichRecentRemovalRatings(env,{[id]:rating},requestedAt);return {filmId:id,status:saved?'saved':'unchanged',rating};
}
// AIR-268: films removed from the watchlist are looked up one by one on their own member page, so a removal event gets
// its rating without the 31-page films list. REMOVAL_RATING_LOOKUP is retired and unread (ADR 0077): this lookup is
// the permanent bounded fallback. The queue is bounded, each attempt is recorded before its request (a killed request
// cannot loop), a 403 or 429 stops the batch, and a film is retried at most REMOVAL_LOOKUP_MAX_ATTEMPTS times.
// No rating found never means watched.
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
// The version 1 to version 2 conversion of ratings_storage_migrate. Version 1 entries carry no event key: they become
// `refs: []` with `legacy: true`. A hand-over still in sync.json gets its references from its saved watchlist event.
function migrateRemovalQueue(queue,handover,at){
 const next={schemaVersion:2,films:{},droppedRefs:0,migratedAt:at};
 if(queue?.pausedUntil){next.pausedUntil=queue.pausedUntil;next.pausedBy=queue.pausedBy||null;}
 for(const [id,entry] of Object.entries(queue?.films||{}))next.films[id]={...entry,claim:null,refs:[],legacy:true};
 if(handover)for(const item of handover)applyRemovalEnqueue(next,item.films,item.ref,at);
 return next;
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
// `ref` names the removal event of this hand-over; a version 1 queue ignores it, a version 2 queue stores it.
async function lookupRemovalRatings(env,incoming=[],now=Date.now(),ref=null){
 const at=new Date(now).toISOString(),summary={checked:0,rated:0,notRated:0,failed:0,stoppedBy:null,pending:0,expired:0,queued:0};
 try{
  const films=(Array.isArray(incoming)?incoming:[]).map(removalLookupFilm).filter(Boolean);
  let queue=await mergeStoredJSON(env,REMOVAL_LOOKUP_KEY,REMOVAL_QUEUE_EMPTY,q=>{
   const changed=applyRemovalEnqueue(q,films,ref,at);
   return pruneRemovalQueue(q,now)||changed?q:null;
  });
  // A 403 or 429 is about the source, not the film: the whole queue waits until the backoff ends. No fact probe and no GET.
  if(queue.pausedUntil&&Date.parse(queue.pausedUntil)>now){summary.stoppedBy=queue.pausedBy||'blocked';summary.pausedUntil=queue.pausedUntil;}
  const facts=summary.stoppedBy?{gettable:[]}:await resolveDueRemovalFacts(env,now,{limit:REMOVAL_FACT_BATCH,getBudget:REMOVAL_LOOKUP_BATCH});
  if(facts.queue)queue=facts.queue;
  const due=summary.stoppedBy?[]:facts.gettable;
  for(const id of due){
   // Claim first: a request killed mid-lookup leaves a counted attempt and a later retry time, never a free retry.
   let token=null;
   queue=await mergeStoredJSON(env,REMOVAL_LOOKUP_KEY,REMOVAL_QUEUE_EMPTY,q=>{if(removalQueueV2(q)&&!token)token=crypto.randomUUID();return claimRemovalEntry(q,id,now,at,token)?q:null;});
   if(!removalClaimHeld(queue,id,at,token))continue;
   const claimed=queue.films[id];
   let result=null,error=null;try{result=await refreshPersonalRating(env,{id,url:claimed.url});}catch(e){error=String(e.message);}
   queue=await mergeStoredJSON(env,REMOVAL_LOOKUP_KEY,REMOVAL_QUEUE_EMPTY,q=>applyRemovalOutcome(q,id,result,error,at,now,token)?q:null);
   if(removalQueueV2(queue)&&queue.films[id]?.state==='rated')await settleRemovalRefs(env,{ids:[id]});
   const entry=queue.films[id];summary.checked++;
   if(entry?.state==='rated')summary.rated++;else if(entry?.lastResult==='not_rated')summary.notRated++;else if(error)summary.failed++;
   if(entry?.lastResult==='blocked'||entry?.lastResult==='rate_limited'){summary.stoppedBy=entry.lastResult;summary.pausedUntil=queue.pausedUntil;break;}
  }
  summary.queued=Object.keys(queue.films).length;summary.pending=Object.values(queue.films).filter(entry=>entry.state==='pending').length;summary.expired=Object.values(queue.films).filter(entry=>entry.state==='expired').length;
  return {...summary,at};
 }catch(e){return {...summary,at,error:String(e.message).slice(0,160)};}
}
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
 const watchlistIds=new Set((report.films||[]).map(f=>String(f.id))),extra=new Set((extraIds||[]).map(id=>String(id)).filter(id=>/^[a-zA-Z0-9_-]{1,80}$/.test(id)));
 let rated=0;for(const id of watchlistIds)if(seen.get(id)!=null)rated++;
 const observedAt=new Date().toISOString(),removedRatings={};
 for(const id of extra){if(!seen.has(id))continue;const rating=confirmedHalfStar(seen.get(id));if(rating!=null)removedRatings[id]=rating;}
 // The scan is one summary observation (ADR-0024): absence never clears a rating. Since LETTERBOXD_FACTS was retired
 // (ADR 0055) the fact records are the only writer of the films list.
 const facts=await LetterboxdFacts.applyFilmsListScan(env,{scanId:'films-list-'+(report.runId||crypto.randomUUID()),observedAt:scanStartedAt,films:Object.fromEntries(seen),total},{watchlistFilms:report.films||[]});return {pages,watched:total,watchlistRated:rated,changed:facts.written,removedRatings,observedAt,facts:{written:facts.written,carried:facts.carried,conflicts:facts.conflicts,outcomes:facts.outcomes}};
}
async function repairRemovedBaselineRatings(env,report){
 const baseline=await loadJSON(env,diagnosticSnapshotKey);if(!baseline)return {attempted:0,saved:0,errors:[]};
 const current=new Set((report.films||[]).map(f=>String(f.id))),index=await ensureInitialRatings(env);
 const candidates=baseline.films.filter(f=>!current.has(f.filmId)&&f.actualAtFreeze===null&&index[f.filmId]?.actualRating==null&&/^https:\/\/letterboxd\.com\/film\/[a-z0-9-]+\/$/.test(f.letterboxdUri)).slice(0,10);
 const results=[];for(const f of candidates){try{results.push(await refreshPersonalRating(env,{id:f.filmId,url:f.letterboxdUri}));}catch(e){results.push({filmId:f.filmId,error:String(e.message).slice(0,160)});}}
 return {attempted:results.length,saved:results.filter(r=>r.status==='saved').length,errors:results.filter(r=>r.error)};
}
// The diary repair after a failed films list. It reads the rated rows through the one diary parser
// (LetterboxdDiary.parsePage); when the diary history stage already read page 1 in this run, it reuses those rows
// instead of a second request. Each changed rating is confirmed on the film's own page before it is written.
function diaryRatedEntries(rows){
 const entries=rows.filter(row=>row.lid&&row.ratingAtEntry!=null).map(row=>({id:row.lid,rating:row.ratingAtEntry}));
 if(!entries.length)throw new Error('Incomplete Letterboxd diary page');
 return entries;
}
async function repairRecentDiaryRatings(env,report,firstPageRows=null){
 // null: the history stage did not run, so the repair reads page 1 itself. An array: the stage ran this commit; its rows
 // are used as they are and nothing is requested again, even when the stage could not read the page.
 let rows=firstPageRows;
 if(rows!=null&&!rows.length)throw new Error('Letterboxd diary page 1 was not read in this run');
 if(rows==null){
  const response=await fetch(LetterboxdDiary.pageUrl(sourceConfig(env).letterboxdUsername,1),{headers:{'User-Agent':'Mozilla/5.0 (compatible; WatchlistAirtime/1.0)','Accept':'text/html','Accept-Language':'en-US,en;q=0.9'},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('Letterboxd diary HTTP '+response.status);
  rows=LetterboxdDiary.parsePage(await response.text()).rows;
 }
 const entries=diaryRatedEntries(rows),baseline=await loadJSON(env,diagnosticSnapshotKey),index=await ensureInitialRatings(env);
 const films=new Map([...(report.films||[]).map(f=>[String(f.id),{id:String(f.id),url:f.url}]),...(baseline?.films||[]).map(f=>[f.filmId,{id:f.filmId,url:f.letterboxdUri}])]);
 const changed=new Map(entries.filter(e=>films.has(e.id)&&index[e.id]?.actualRating!==e.rating).map(e=>[e.id,e]));
 const results=[];for(const id of changed.keys()){try{results.push(await refreshPersonalRating(env,films.get(id)));}catch(e){results.push({filmId:id,error:String(e.message).slice(0,160)});}}
 return {diaryEntries:entries.length,reused:firstPageRows!=null,attempted:results.length,saved:results.filter(r=>r.status==='saved').length,errors:results.filter(r=>r.error)};
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
// A paused exhausted chunk_budget is not "running" merely because its checkpoint is younger than 48 hours.
// It stays waiting until two nominal hourly triggers after nextCatchUpAt, plus this slack, have passed.
// One missed trigger is ordinary lateness. A live resolver lease is running on its own and is not part of
// the slack. Exactly at the end the state stays waiting. This clock does not read the task registry or any usage account.
const RESOLVER_PROGRESS_EPOCHS=2;
const RESOLVER_PROGRESS_SLACK_MS=45*60*1000;
function resolverProgressGraceEnd(gateMs,schedule=HOURLY_TASK_SCHEDULE){
 if(!Number.isFinite(gateMs))return null;
 let at=gateMs,nominal=null;
 for(let epoch=0;epoch<RESOLVER_PROGRESS_EPOCHS;epoch++){
  nominal=hourlyTaskRunAt(at,schedule);
  if(!nominal)return null;
  at=Date.parse(nominal)+1;
 }
 const end=Date.parse(nominal)+RESOLVER_PROGRESS_SLACK_MS;
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
 const head=typeof PredictionD1==='undefined'?null:await PredictionD1.openLease(env,RUNNER_LEASE_KEY),object=head?head.object:await env.BUCKET.get(RUNNER_LEASE_KEY),old=head?head.value:(object?await object.json():null),now=Date.now();
 if(operation==='acquire'&&old?.expiresAt>now)return {status:'already_running',runId:old.runId,expiresAt:old.expiresAt};
 if(operation!=='acquire'&&(!old||old.runId!==runId||old.expiresAt<=now))return {status:'lease_lost',runId:old?.runId||null};
 const value={owner:runId,runId,heartbeatAt:new Date(now).toISOString(),expiresAt:operation==='release'?0:now+RUNNER_LEASE_TTL};
 const saved=head?await PredictionD1.writeLease(env,head,value):await env.BUCKET.put(RUNNER_LEASE_KEY,JSON.stringify(value),{onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});
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
async function runnerStarted(env,run,resumed,queue,inputs=null){
 const snapshot=await predictionEventSnapshot(env,queue,run.batchSize,inputs),runState=run.startResult==='recovered_stale_lease'?'recovered':resumed?'resumed':'started';
 run.coverageStartCurrentPredictions=snapshot.coverage?.currentPredictionsTotal??null;await savePredictionRun(env,run);
 const event={id:'prediction-start-'+run.runId,type:'enrichment',at:run.createdAt,startedAt:run.createdAt,stage:resumed?'resumed':'started',runState,title:runState==='recovered'?'Прогнозы восстановлены':resumed?'Прогнозы продолжены':'Прогнозы запущены',queueSchemaVersion:6,hotRemaining:queue?.priorityCount??null,coldRemaining:queue?.coldRemaining??null,currentBatchSize:run.batchSize,delta:{added:0,updated:0,failed:0,predictionGain:0},snapshot};
 const key=START_EVENT_PREFIX+run.runId+'.json';await saveJSON(env,key,{event});if(!await flushStopEvent(env,{event},key))await noteEventOutbox(env,key);
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
 const settled=await settleRunRetries(env,run,'stop_retries'),key=STOP_EVENT_PREFIX+id+'.json',existing=await loadJSON(env,key);let record=existing;
 if(!record){let queue=null;try{queue=await loadJSON(env,predictionQueueKey);}catch{}const summary=runSummary(run),at=run.event?.at||run.completedAt||new Date().toISOString();
 const snapshot=await predictionEventSnapshot(env,queue,run.batchSize),delta=predictionEventDelta(run,summary,snapshot),event={remaining:queue?(queue.priorityCount||0)+(queue.coldRemaining||0):null,id:run.event?.id||'enrichment-'+id,type:'enrichment',runId:id,at,queueSchemaVersion:6,stage:'partial',title:'Прогнозы приостановлены',reason:systemicReason(reason),stopReason:systemicReason(reason),trigger:run.trigger,added:summary.added,updated:summary.updated,failed:summary.failed,checked:summary.checked,processed:summary.processed,hotProcessed:summary.hotProcessed,coldProcessed:summary.coldProcessed,batchCount:summary.batchCount,batchesProcessed:predictionBatchesProcessed(run),hotRemaining:queue?.priorityCount??fallback.hotRemaining??run.hotRemaining??null,coldRemaining:queue?.coldRemaining??fallback.coldRemaining??run.coldRemaining??null,delta,snapshot};
 record={event};const saved=await env.BUCKET.put(key,JSON.stringify(record),{onlyIf:{etagDoesNotMatch:'*'}});if(saved===null)record=await loadJSON(env,key);
 }
 run.status='partial';run.reason=record.event.reason;run.stopReason=record.event.reason;run.completedAt=record.event.at;run.event=record.event;run.counts={created:record.event.added,recalculated:record.event.updated,failed:record.event.failed,pending:(record.event.hotRemaining||0)+(record.event.coldRemaining||0)};
 if(fallback.callerFault&&!run.callerFault)run.callerFault=fallback.callerFault;
 await saveJSON(env,runKey(id),run);await diagnosticCheckpoint(env,run);const latest=await loadJSON(env,ENRICHMENT_KEY+'latest-run.json');if(!latest||latest.runId===id||fallback.start)await saveJSON(env,ENRICHMENT_KEY+'latest-run.json',run);
 const written=await flushStopEvent(env,record,key);if(!written&&!fallback.outbox)await noteEventOutbox(env,key);await runnerLease(env,id,'release');return {...record.event,status:'partial',mustComplete:true,eventPending:!written,counts:run.counts,...(settled?{}:{retryHeal:'pending'})};
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
 const report={checked:0,delivered:0,failed:0,quarantined:0};
 try{
  const [index,latest]=await Promise.all([loadJSON(env,EVENT_OUTBOX_KEY),loadJSON(env,ENRICHMENT_KEY+'latest-run.json')]);
  const pending=isObject(index?.pending)?index.pending:{},indexed=Object.keys(pending).filter(eventOutboxKey);
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
     if(key.startsWith(STOP_EVENT_PREFIX)){const stop=await recordRunStop(env,record.event.runId,record.event.reason,{outbox:true});result=stop.status==='superseded'||stop.eventPending===false?'delivered':'failed';}
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
// The read side of the outbox: counts only, one small object, no write.
async function eventOutboxStatus(env){
 try{
  const index=await loadJSON(env,EVENT_OUTBOX_KEY),entries=Object.entries(isObject(index?.pending)?index.pending:{}).filter(([key])=>eventOutboxKey(key));
  const since=entries.map(([,entry])=>entry?.since).filter(value=>typeof value==='string').sort()[0]||null;
  return {pending:entries.filter(([,entry])=>!entry?.quarantined).length,quarantined:entries.filter(([,entry])=>entry?.quarantined).length,oldestSince:since,maxAttempts:EVENT_OUTBOX_ATTEMPTS};
 }catch{return {pending:null,quarantined:null,oldestSince:null,maxAttempts:EVENT_OUTBOX_ATTEMPTS};}
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
// AIR-417. Where a failed prediction boundary failed: the stage, the sanitized error code and guard, one log line per failure. Never a
// message, a stack, a film id or a body. The 502 answer is unchanged. `stage` is set on the error by atStage at the first boundary it crosses.
const SAFE_LOG_TOKEN=/^[a-z0-9_]{1,60}$/,SAFE_LOG_ID=/^[A-Za-z0-9_-]{1,100}$/;
const safeLogToken=value=>typeof value==='string'&&SAFE_LOG_TOKEN.test(value)?value:null;
async function atStage(name,work){try{return await work();}catch(error){if(error&&typeof error==='object'&&!error.stage)error.stage=name;throw error;}}
function logPredictionFailure(boundary,error,requestId,runId){
 try{console.warn(JSON.stringify({event:'prediction_boundary_failed',boundary:safeLogToken(boundary),stage:safeLogToken(error?.stage)||'unknown',code:safeLogToken(error?.code)||'unknown',guard:safeLogToken(error?.guard),kind:safeLogToken(String(error?.name||'').toLowerCase()),requestId:typeof requestId==='string'&&SAFE_LOG_ID.test(requestId)?requestId:null,runId:typeof runId==='string'&&SAFE_LOG_ID.test(runId)?runId:null}));}catch{/* logging never changes the outcome */}
}
async function observedPrediction(env,body,work,stage,requestId){
 const correlation=safeRequestId(requestId)||crypto.randomUUID();
 const started=Date.now(),attemptedAt=new Date(started).toISOString(),traceId=body?.diagnosticRunId||body?.runId||null;
 const stopId=()=>body?.runId||'blocked-'+(body?.trigger==='scheduled'?'scheduled':'manual')+'-'+Math.floor(Date.now()/3600000);
 const entered=predictionStep({step:stage,requestId:correlation,attemptedAt,outcome:'entered'});
 await safeAppendStep(env,traceId,entered);
 let response,data;try{response=await work();data=await response.clone().json();}catch(error){
  logPredictionFailure(stage,error,correlation,traceId);
  const id=stopId();
  await safeAppendStep(env,traceId||id,predictionStep({step:stage,requestId:correlation,attemptedAt,outcome:'failed',httpStatus:502,elapsedMs:Date.now()-started,errorClass:'storage_error'}));
  const stop=await recordRunStop(env,id,'storage_error',{start:stage==='start',trigger:body?.trigger});
  return withPredictionCorrelation(json({...stop,error:'storage_error'},502),correlation);
 }
 const normal=['queue_empty','eligible_queue_empty','retry_backoff'];
 // A start that cannot write the previous run's retries took no lease and created no run: it is not a stop of anything.
 const stop=data.code==='prediction_retry_heal_pending'||data.code==='prediction_catalog_held'?null:data.status==='lease_lost'?'lease_lost':data.mustComplete&&!normal.includes(data.stopReason)?data.stopReason:data.status==='blocked'&&data.reason!=='retry_backoff'?data.reason:response.status>=500?'storage_error':response.status===409&&data.error?.includes('Profile changed')?'profile_changed':stage==='start'&&response.status===409&&data.error?'model_unavailable':null;
 const errorClass=stop==='lease_lost'||stop==='storage_error'||stop==='format_error_storm'?stop:null;
 const produced=predictionStep({step:stage,requestId:correlation,attemptedAt,completedAt:new Date().toISOString(),outcome:'produced',httpStatus:response.status,elapsedMs:Date.now()-started,errorClass});
 if(stop){const id=stopId();const final=await recordRunStop(env,id,stop,{...data,start:stage==='start',trigger:body?.trigger});await safeAppendStep(env,traceId||id,produced);return withPredictionCorrelation(json({...data,...final,stage:stage==='start'?'blocked':final.stage,status:stage==='start'?'blocked':data.status||'partial'},response.status),correlation);}
 await safeAppendStep(env,traceId,produced);
 return withPredictionCorrelation(response,correlation);
}
async function predictionWriter(env,work){
 const head=typeof PredictionD1==='undefined'?null:await PredictionD1.openLease(env,PREDICTION_MUTATION_LEASE),object=head?head.object:await env.BUCKET.get(PREDICTION_MUTATION_LEASE),old=head?head.value:(object?await object.json():null);
 if(old?.expiresAt>Date.now())return json({status:'busy',reason:'prediction_writer_busy',...scheduledRunFields()},409);
 const lease={id:crypto.randomUUID(),expiresAt:Date.now()+90000},saved=head?await PredictionD1.writeLease(env,head,lease):await env.BUCKET.put(PREDICTION_MUTATION_LEASE,JSON.stringify(lease),{onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});
 if(saved===null)return json({status:'busy',reason:'prediction_writer_busy',...scheduledRunFields()},409);
 try{return await work();}finally{
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
async function mutatePredictionQueue(env,apply,trigger){
 for(let attempt=0;attempt<PREDICTION_QUEUE_ATTEMPTS;attempt++){
  await predictionQueuePause(attempt);
  const head=typeof PredictionD1==='undefined'?null:await PredictionD1.openQueue(env),object=head?head.object:await env.BUCKET.get(predictionQueueKey),current=head?head.queue:(object?await object.json():null);if(!current)return null;
  const next=apply(cloneJSON(current));if(next==null)return current;
  if((head?await PredictionD1.writeQueue(env,head,next):await putPredictionQueue(env,object,next))!==null)return next;
 }
 throw new PredictionQueueConflictError(trigger);
}
// A retry record only grows while its film is outstanding: attempts and retryAt never go back, and the same run's record
// is written once.
function mergeRetryRecord(existing,failure,runId){
 if(existing?.lastRunId===runId)return existing;
 const attempts=Math.max(failure.attempts||0,(existing?.attempts||0)+1),failedMs=Date.parse(failure.failedAt)||Date.now();
 return {...failure,attempts,retryAt:Math.max(failure.retryAt||0,existing?.retryAt||0,failedMs+Math.min(6*3600000,3600000*2**(attempts-1))),lastRunId:runId};
}
// The run's failures not yet in the queue (a lost or failed submit write) are recorded; returns whether any was added.
function recordRunRetries(queue,run){
 queue.retries||={};let added=false;
 for(const [id,failure] of Object.entries(run.failures||{})){
  const record=failure&&typeof failure==='object'?failure:{kind:failure};
  const merged=mergeRetryRecord(queue.retries[id],{kind:record.kind||'storage_error',scope:record.scope||'run',retryable:true,failedAt:record.failedAt||run.completedAt||new Date().toISOString(),retryAt:record.retryAt||0,attempts:record.attempts||0,...(record.validation?{validation:record.validation}:{})},run.runId);
  if(merged!==queue.retries[id]){queue.retries[id]=merged;added=true;}
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
async function settlePreviousRun(env){
 const lease=await loadJSON(env,RUNNER_LEASE_KEY);if(!lease?.runId||lease.expiresAt>Date.now())return null;
 const run=await checkedRun(env,lease.runId);if(run?.retryHeal!=='pending')return null;
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
  const queue=await buildPredictionQueue(env,source,trigger,previous,capture);if(!queue)return null;
  const next=amend?amend(queue)||queue:queue;
  if(beforeWrite)await beforeWrite();
  if((head?await PredictionD1.writeQueue(env,head,next):await putPredictionQueue(env,object,next))!==null)return next;
 }
 throw new PredictionQueueConflictError(trigger);
}
// A rebuild reads the whole catalog; a Discovery chunk that commits between its statements is a transient fence, so the read is repeated a
// few times with a short pause. A held cutover or an incomplete load keeps failing and is raised to the caller as before.
async function loadCatalogForQueue(pinned){
 for(let attempt=1;;attempt++){
  try{return await loadJSON(pinned,'epg/discovered-films.json');}
  catch(error){if(error?.code!=='discovery_fence'||attempt>=CATALOG_FENCE_ATTEMPTS)throw error;}
 }
}
async function buildPredictionQueue(env,report,trigger,previous,capture=null){
 const pinned=report?.runId?{...env,epgPin:{programmeRunId:report.runId}}:await pinEpg(env);
 const [profile,storedIndex,catalog]=await Promise.all([loadJSON(env,profileKey),loadJSON(env,ENRICHMENT_KEY+'view-index.json'),loadCatalogForQueue(pinned)]);
 const index=typeof PredictionD1==='undefined'?storedIndex:await PredictionD1.overlayIndex(env,storedIndex,canonicalMoodFacet);
 if(!profile||!report?.films)return null;
 if(capture)Object.assign(capture,{report,profile,index,catalog});
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
 return queue;
}
// AIR-431. The Prediction queue advances on its own state. A runner step (next, submit, complete) no longer rebuilds the queue from the
// whole Discovery catalog: the persisted queue is the work list, a film that was predicted is settled out of it, and only the films a step
// actually needs (the metadata of the next batch) are read, by id. A full rebuild remains for start, a changed programme, profile or
// contract, and the named refresh callers; Discovery chunk traffic moves the Discovery generation, which no longer reaches the runner.
const QUEUE_STALE_LIMIT_MS=12*3600000;
const CATALOG_FENCE_ATTEMPTS=3;
const SETTLED_STATUSES=['created','recalculated','already_current'];
const queueShapeValid=queue=>!!queue&&typeof queue==='object'&&Array.isArray(queue.pending)&&Array.isArray(queue.hotPending)&&Array.isArray(queue.coldPending)&&!!queue.priority&&typeof queue.priority==='object'&&Number.isInteger(queue.priorityCount);
// Why a persisted queue cannot be advanced as it is (null: it can). The same inputs a rebuild stamps into the queue.
async function queueAdvanceGate(queue,report,profile){
 if(!queueShapeValid(queue))return 'queue_shape';
 if(!report?.runId||queue.programmeRunId!==report.runId)return 'programme_changed';
 if(!profile||queue.profileHash!==profile.profileHash||queue.profileVersion!==profile.version)return 'profile_changed';
 if(queue.fingerprintSchemaVersion!==FINGERPRINT_SCHEMA_VERSION||(queue.fingerprintPromptVersion??1)!==FINGERPRINT_PROMPT_VERSION||queue.predictionPromptVersion!==PREDICTION_PROMPT_VERSION)return 'contract_changed';
 if(queue.fingerprintCompatibility?.registryDigest!==(await fingerprintRegistryDigests()).registry)return 'registry_changed';
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
 const pendingSet=new Set(queue.pending);
 queue.priorityCount=queue.hotPending.length;queue.coldRemaining=queue.coldPending.length;queue.urgentCount=queue.hotPending.filter(id=>queue.priority[id]?.rank===0).length;queue.coldWithoutPrediction=queue.coldPending.filter(id=>!pendingSet.has(id)).length;
 queue.hotPredicted=(queue.hotPredicted||0)+hotGone;queue.advancedAt=new Date().toISOString();
 return queue;
}
// The persisted queue when it can be advanced, otherwise a full rebuild. `force` rebuilds anyway (start). `fallback` lets a start that
// finds the catalog held keep working on a persisted queue that is still valid and not older than QUEUE_STALE_LIMIT_MS; the answer then
// carries `queueStale` (never silent). Any other failure, and a stale or invalid queue, is thrown as before.
async function currentPredictionQueue(env,report,profile,trigger,{force=false,fallback=false,capture=null}={}){
 const stored=await loadJSON(env,predictionQueueKey),why=await queueAdvanceGate(stored,report,profile);
 if(!force&&!why)return stored;
 try{return await refreshPredictionQueue(env,report,trigger,{capture});}
 catch(error){
  const age=stored?.refreshedAt?Date.now()-Date.parse(stored.refreshedAt):Infinity;
  if(fallback&&!why&&CATALOG_HELD_CODES.includes(error?.code)&&age<=QUEUE_STALE_LIMIT_MS){return Object.assign(stored,{queueStale:{reason:error.code,ageMs:age}});}
  throw error;
 }
}
// Films by id, for the metadata of a batch: the watchlist first, then the admitted catalog films by indexed id lookup (never the whole
// catalog). Outside D1 authority the R2 catalog serves them.
async function readFilmsById(env,report,ids,known=undefined){
 const wanted=[...new Set((ids||[]).map(String))],found=new Map(),watchlist=new Map(eligibleEnrichmentFilms(report).map(f=>[String(f.id),f])),rest=[];
 for(const id of wanted){const film=watchlist.get(id);if(film)found.set(id,film);else rest.push(id);}
 if(!rest.length)return found;
 if(known){for(const id of rest){const film=known[id]||Object.values(known).find(f=>String(f?.id)===id);if(film)found.set(id,film);}return found;}
 const authority=typeof DiscoveryAuthority==='undefined'?null:await DiscoveryAuthority.readAdmissionsById(env,rest);
 if(authority?.handled){for(const [id,film] of authority.films)found.set(id,film);return found;}
 const catalog=await loadJSON(env,'epg/discovered-films.json')||{};
 for(const id of rest){const film=catalog[id]||Object.values(catalog).find(f=>String(f?.id)===id);if(film)found.set(id,film);}
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
// `inputs` are the objects a queue rebuild of this request already read; with them nothing large is read again.
async function predictionEventSnapshot(env,queue,batchSize=null,inputs=null){
 const unreadable=new Set(),safe=async key=>{try{return await loadJSON(pinned,key);}catch{unreadable.add(key);return null;}},given=inputs?.report&&inputs.profile&&inputs.index!==undefined&&inputs.catalog!==undefined,pinned=given?env:await pinEpg(env),[profile,index,report,catalog,persistedQueue]=await Promise.all([given?inputs.profile:safe(profileKey),given?inputs.index:safe(ENRICHMENT_KEY+'view-index.json'),given?inputs.report:safe('programme.json'),given?inputs.catalog:safe('epg/discovered-films.json'),queue===undefined||queue===null?safe(predictionQueueKey):queue]);
 // AIR-431. A source that could not be read (a held or failing catalog) makes the coverage unknown: it is never computed from a missing catalog
 // and reported as a drop. The run, the queue slices and the delta (predictionGain null) do not depend on it.
 const coverage=unreadable.has('epg/discovered-films.json')||unreadable.has('programme.json')||unreadable.has(ENRICHMENT_KEY+'view-index.json')?null:canonicalCoverageSummary(report,catalog,index,profile,Date.now(),await predictionFreshness(env,profile));
 return {coverage:coverage?{...coverage,localPercent:coveragePercent(coverage.currentPredictionsTotal,coverage.confirmedFilmsTotal),windowPercent:coveragePercent(coverage.windowCurrentPredictions,coverage.windowFilmsTotal)}:null,queue:predictionQueueSlices(persistedQueue),...(Number.isInteger(batchSize)&&batchSize>0?{currentBatchSize:batchSize}:{})};
}
function predictionEventDelta(run,summary,snapshot){const current=snapshot?.coverage?.currentPredictionsTotal,start=run.coverageStartCurrentPredictions;return {added:summary.added,updated:summary.updated,failed:summary.failed,predictionGain:Number.isInteger(current)&&Number.isInteger(start)?current-start:null};}
const INTEGRATION_STALE_MS=48*3600000;
function integrationTime(value){const ms=Date.parse(value);return Number.isFinite(ms)?new Date(ms).toISOString():null;}
// Owner-facing “программа обновлена”: the successful end of the published run (`completedAt` / complete `sync.json`
// `updatedAt`), the same instant the `epg` event stores as `at`. Not scan `report.updatedAt`, not `startedAt`/`dueAt`,
// not D1 `published_epg_generation.published_at` (that column still copies the scan clock at pointer switch). An
// in-flight or failed later run keeps `lastEpgPublishedAt` from the last complete record. Missing or invalid → null.
function epgUxPublishedAt(sync,report){
 if(sync?.stage==='complete'&&!sync.error&&(!report?.runId||!sync.runId||sync.runId===report.runId))return integrationTime(sync.completedAt||sync.updatedAt);
 return integrationTime(sync?.lastEpgPublishedAt);
}
function integrationEntry(id,role,state,code,lastSuccessAt,lastFailureAt){return {id,role,state,code,lastSuccessAt:lastSuccessAt||null,lastFailureAt:lastFailureAt||null};}
function ratingsFailureCode(kind){if(kind==='blocked'||kind==='anti_bot')return 'ratings_blocked';if(kind==='http_429')return 'ratings_rate_limit';if(kind==='degraded'||kind==='incomplete')return 'ratings_incomplete';if(kind==='lookup_failed'||kind==='publish_failed'||kind==='failed')return 'ratings_failed';return null;}
function ratingsMessageCode(message){if(/403|anti-bot/i.test(message))return 'ratings_blocked';if(/429/.test(message))return 'ratings_rate_limit';if(/incomplete|pagination changed|duplicate letterboxd/i.test(message))return 'ratings_incomplete';return 'ratings_failed';}
function resolverMatches(programmeRunId,reportRunId){if(!programmeRunId||!reportRunId)return true;return programmeRunId===reportRunId;}
function integrationHealth({sync,ratings,enabled,report,continuation,discoveryStatus,run,live,now,watchlistIngest,ratingsRun=null,ratingsBlocked=null,discoveryReady=null,resolverLease=null}){
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
  if(ratingsBlocked)return entry('degraded','ratings_migration_blocked',null,null,{pipeline:'blocked',migration:ratingsBlocked.migration});
  if(ratingsRun)return ratingsRun.state==='ok'?entry(fresh(ratingsRun.lastSuccessAt),freshCode(ratingsRun.lastSuccessAt),ratingsRun.lastSuccessAt,ratingsRun.lastFailureAt,{pipeline:'separate'}):entry(ratingsRun.state,ratingsRun.code,ratingsRun.lastSuccessAt,ratingsRun.lastFailureAt,{pipeline:'separate'});
  if(ratingPending&&(!latestRating||latestRating.ok&&(!pendingSince||Date.parse(latestRating.at)<=Date.parse(pendingSince))))return entry('degraded','ratings_pending',ratingSuccess,ratingFailureAt,{pendingSince});
  if(!latestRating)return entry('unknown','no_data',null,null);
  if(!latestRating.ok)return entry(latestRating.code==='ratings_failed'?'failed':'degraded',latestRating.code,ratingSuccess,ratingFailureAt);
  return entry(fresh(ratingSuccess),freshCode(ratingSuccess),ratingSuccess,ratingFailureAt);
 })();
 const epgFailure=sync?.error?integrationTime(sync.updatedAt):null,epgSuccess=epgUxPublishedAt(sync,report);
 const epg=(()=>{
  if(sync?.error){const code=/HTTP/i.test(sync.error)?'epg_http':/cover the current window/i.test(sync.error)?'epg_window':/parse|xml|unexpected/i.test(sync.error)?'epg_parse':'epg_failed';return integrationEntry('epg','source','failed',code,epgSuccess,epgFailure);}
  if(sync?.stage==='complete')return integrationEntry('epg','source',fresh(epgSuccess),freshCode(epgSuccess),epgSuccess,null);
  if(sync&&['metadata','epg','seal'].includes(sync.stage)){const elapsed=age(sync.updatedAt);return elapsed!=null&&elapsed<15*60000?integrationEntry('epg','source','running','running',epgSuccess,null):integrationEntry('epg','source','degraded','epg_failed',epgSuccess,integrationTime(sync.updatedAt));}
  return integrationEntry('epg','source','unknown','no_data',epgSuccess,null);
 })();
 const reportRunId=report?.runId||null,resolverConfirmed=[];
 if(discoveryStatus?.stage==='complete'&&!discoveryStatus.error){const at=integrationTime(discoveryStatus.finishedAt||discoveryStatus.at);if(at)resolverConfirmed.push({at,current:resolverMatches(discoveryStatus.programmeRunId,reportRunId)});}
 if(continuation?.stage==='complete'){const at=integrationTime(continuation.at);if(at)resolverConfirmed.push({at,current:resolverMatches(continuation.programmeRunId,reportRunId)});}
 const byTime=(a,b)=>Date.parse(a)-Date.parse(b),priorResolverSuccess=resolverConfirmed.map(item=>item.at).sort(byTime).at(-1)||null,currentResolverSuccess=resolverConfirmed.filter(item=>item.current).map(item=>item.at).sort(byTime).at(-1)||null;
 const resolverProgress=()=>{const elapsed=age(continuation?.at);return integrationEntry('resolver','source',elapsed>INTEGRATION_STALE_MS?'stale':'running',elapsed>INTEGRATION_STALE_MS?'stale':'running',priorResolverSuccess,null);};
 // Exhausted chunk_budget is a schedule gate, not a live writer. Waiting is not attention. The stall code
 // means a same-generation batch was stored and none newer than the gate was. A missing status, an unusable
 // checkpoint or batch time, or a batch from another generation is unknown evidence, not that code, and the
 // code never asserts an external usage quota.
 const chunkBudgetRecognition=()=>{
  const skew=5*60*1000,skewed=value=>Number.isFinite(value)&&value>now+skew;
  const checkpoint=integrationTime(continuation?.at),checkpointMs=checkpoint?Date.parse(checkpoint):NaN,gate=integrationTime(continuation?.nextCatchUpAt),gateMs=gate?Date.parse(gate):NaN;
  const batchAt=integrationTime(discoveryStatus?.finishedAt),batchMs=batchAt?Date.parse(batchAt):NaN;
  const pinned=continuation?.programmeRunId,published=reportRunId,sameGeneration=!!(pinned&&published&&pinned===published);
  const statusGeneration=discoveryStatus?.programmeRunId,batchSameGeneration=!!(statusGeneration&&pinned&&published&&statusGeneration===pinned&&statusGeneration===published);
  const later=(a,b)=>[a,b].filter(Boolean).sort((x,y)=>Date.parse(x)-Date.parse(y)).at(-1)||null;
  const success=later(priorResolverSuccess,checkpoint&&!skewed(checkpointMs)?checkpoint:null);
  const entry=(state,code,extra={})=>({...integrationEntry('resolver','source',state,code,success,null),lastBatchAt:batchSameGeneration&&batchAt&&!skewed(batchMs)?batchAt:null,...extra});
  if(resolverLease?.expiresAt>now)return resolverProgress();
  if(continuation?.retryAt&&Date.parse(continuation.retryAt)>now)return integrationEntry('resolver','source','degraded','resolver_backoff',success,checkpoint);
  if(skewed(checkpointMs)||skewed(batchMs))return entry('unknown','no_data');
  if(continuation?.remainingChunks>0)return resolverProgress();
  const epgSettled=sync?.stage==='complete'&&!sync.error,exhausted=continuation?.remainingChunks===0;
  if(!sameGeneration||!epgSettled||!exhausted||!Number.isFinite(gateMs))return entry('waiting','resolver_waiting');
  if(gateMs>now)return entry('waiting','resolver_waiting',{gateAt:gate});
  const graceEnd=resolverProgressGraceEnd(gateMs);
  if(graceEnd==null||now<=graceEnd)return entry('waiting','resolver_waiting',{gateAt:gate});
  if(batchSameGeneration&&Number.isFinite(batchMs)&&batchMs>gateMs)return entry('waiting','resolver_waiting',{gateAt:gate});
  if(!Number.isFinite(checkpointMs)||!batchSameGeneration||!Number.isFinite(batchMs))return entry('unknown','no_data');
  if(!(Number.isInteger(discoveryReady)&&discoveryReady>0))return currentResolverSuccess?integrationEntry('resolver','source',fresh(currentResolverSuccess),freshCode(currentResolverSuccess),currentResolverSuccess,null):entry('waiting','resolver_waiting',{gateAt:gate});
  return entry('degraded','resolver_no_recent_progress',{gateAt:gate});
 };
 const resolver=(()=>{
  if(continuation?.reason==='missing_secret')return integrationEntry('resolver','source','degraded','resolver_unconfigured',priorResolverSuccess,null);
  if(continuation?.reason==='chunk_budget'&&continuation.stage!=='running')return chunkBudgetRecognition();
  if(['epg_committed','busy'].includes(continuation?.reason)||continuation?.stage==='running')return resolverProgress();
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
  }catch{if(!degraded.includes(name))degraded.push(name);return null;}
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
async function footerStatus(env){
 const degraded=[],guard=footerGuard(env,degraded);
 const pinned=await guard('publication',()=>pinEpg(env))||env;
 const ratingsState=typeof LetterboxdRatings!=='undefined'?await guard('ratings',async()=>{const state=await LetterboxdRatings.migrationState(env);return state.migration==='complete'?{run:LetterboxdRatings.health(await LetterboxdRatings.readRun(env),Date.now())}:{blocked:{migration:state.migration}};}):null;
 const ratingsRun=ratingsState?.run??null,ratingsBlocked=ratingsState?.blocked??null;
 // AIR-344: the ledger is streamed and counted once, without keeping its items, before the other records are read.
 const authority=typeof DiscoveryAuthority!=='undefined'?await guard('discovery_authority',()=>DiscoveryAuthority.readAuthority(env)):null;
 const decisions=authority?.ready?{}:await guard('decisions',()=>loadJSON(env,'epg/discovery-resolution.json'));
 const ledger=await guard('ledger',()=>ledgerStatusAggregates(pinned,decisions||{},Date.now()));
 const [profile,index,report,catalog,storedQueue,run,lease,sync,ratings,discoveryStatus,continuation,watchlistIngest,resolverLease,watchlist,metadata]=await Promise.all([
  guard('profile',()=>loadJSON(env,profileKey)),guard('index',()=>loadJSON(env,ENRICHMENT_KEY+'view-index.json')),guard('programme',()=>footerPublishedDocument(pinned,'programme.json')),guard('catalog',()=>loadJSON(pinned,'epg/discovered-films.json')),
  guard('queue',()=>loadJSON(env,predictionQueueKey)),guard('run',()=>loadJSON(env,ENRICHMENT_KEY+'latest-run.json')),guard('lease',()=>loadJSON(env,RUNNER_LEASE_KEY)),guard('sync',()=>loadJSON(env,'sync.json')),guard('ratings_status',()=>loadJSON(env,RATINGS_STATUS_KEY)),
  guard('discovery_status',()=>loadJSON(env,'epg/discovery-status.json')),guard('continuation',()=>loadJSON(env,'epg/resolver-continuation.json')),guard('watchlist_ingest',()=>loadJSON(env,'watchlist-ingest.json')),guard('resolver_lease',()=>loadJSON(env,'epg/resolver-lease.json')),
  // AIR-389: two more single-object reads, for the collection and the new-film counts.
  guard('watchlist',()=>footerPublishedDocument(pinned,'watchlist.json')),guard('metadata',()=>loadJSON(env,'metadata.json'))
 ]);
 const freshness=await guard('freshness',()=>predictionFreshness(env,profile));
 // Coverage needs the programme, the catalog, the view index and the freshness rule. If any of them could not be read the numbers are unknown, not zero or 100%.
 // A programme or catalog object that is simply absent (the read answered null) is as unreadable as one that failed: it is not an empty collection with 100% coverage.
 if(!footerPlainObject(report)&&!degraded.includes('programme'))degraded.push('programme_missing');
 if(!footerPlainObject(catalog)&&!degraded.includes('catalog'))degraded.push('catalog_missing');
 // An absent view index or taste profile is not a measured 0 current predictions either: without them the coverage is unknown.
 if(!footerPlainObject(index)&&!degraded.includes('index'))degraded.push('index_missing');
 if(!footerPlainObject(profile)&&!degraded.includes('profile'))degraded.push('profile_missing');
 const coverageReadable=!['programme','catalog','index','profile','freshness','programme_missing','catalog_missing','index_missing','profile_missing'].some(name=>degraded.includes(name))&&!!freshness;
 const coverage=coverageReadable?canonicalCoverageSummary(report,catalog,index,profile,Date.now(),freshness):{confirmedFilmsTotal:null,currentPredictionsTotal:null,windowFilmsTotal:null,windowCurrentPredictions:null,cacheOffWindowTotal:null,pendingOffWindowTotal:null};
 const queue=queueStatusView(storedQueue),slices=predictionQueueSlices(storedQueue);
 const collection=footerCollection({report,catalog,watchlist,index,metadata}),newUnseen=footerNewUnseen({report,catalog,watchlist,index,metadata,profile,freshness});
 const recognized=ledger?.recognized??null,counts=ledger?.counts??null;
 const pendingRecognition=counts?counts.currentUnresolved:null,historicalUnresolved=counts?counts.historicalUnresolved+counts.expiredInactive:null;
 const difference=(total,current)=>Number.isInteger(total)&&Number.isInteger(current)?total-current:null;
 const live=run?.status==='running'&&lease?.runId===run.runId&&lease.expiresAt>Date.now(),summary=run?runSummary(run):null;
 const runStatus=!run?'idle':live?'running':run.status==='running'?'blocked':run.status==='partial'?'blocked':run.status==='complete'?'completed':run.status||'idle';
 const rawReason=run?.stopReason||run?.reason,reason=['queue_empty','eligible_queue_empty','retry_backoff'].includes(rawReason)?rawReason:safePredictionReason(rawReason);
 return {schemaVersion:1,generatedAt:new Date().toISOString(),profile:profile?{version:profile.version,updatedAt:profile.updatedAt}:null,collection,recommendations:{newUnseen},coverage:coverageReadable?{...coverage,localPercent:coveragePercent(coverage.currentPredictionsTotal,coverage.confirmedFilmsTotal),windowPercent:coveragePercent(coverage.windowCurrentPredictions,coverage.windowFilmsTotal),windowPendingTotal:coverage.windowFilmsTotal-coverage.windowCurrentPredictions}:{...coverage,localPercent:null,windowPercent:null,windowPendingTotal:null},predictions:{pendingHot:queue?.hotRemaining??difference(coverage.windowFilmsTotal,coverage.windowCurrentPredictions),pendingCold:queue?.coldRemaining??coverage.pendingOffWindowTotal,outstanding:slices.outstanding,eligibleNow:slices.eligibleNow,deferredByRetry:slices.deferredByRetry,nextRetryAt:slices.nextRetryAt,pendingOffWindow:coverage.pendingOffWindowTotal,currentBatch:live?{size:run.batchSize??run.selectedIds?.length??null}:null,nextBatchSize:queue?.adaptiveBatch?.batchSize??0,nextScheduledRun:hourlyTaskRunAt()},epgTmdb:{recognizedFilms:recognized?recognized.size:null,pendingRecognition,historicalUnresolved,ledgerTotal:counts?counts.ledgerTotal:null,confirmedMovies:coverage.confirmedFilmsTotal,cacheOffWindow:coverage.cacheOffWindowTotal,epgStart:report?.stats?.epgStart??null,epgEnd:report?.stats?.epgEnd??null,channels:report?.stats?.channels??null,checkedTransmissions:report?.stats?.scanned??null},watchlist:{films:report?(report.watchlistCount??report.films?.length??0):null,updatedAt:report?.watchlistUpdatedAt||report?.updatedAt||null,titleMissing:report?.stats?.titleMissing??0,titleProvisional:report?.stats?.titleProvisional??0,metadataMissing:report?.stats?.metadataMissing??0},lastRun:run?{status:runStatus,reason,startedAt:run.createdAt||null,finishedAt:run.completedAt||null,added:summary?.added||0,failed:summary?.failed||0}:null,integrations:integrationHealth({sync,ratings,enabled:false,report,continuation,discoveryStatus,run,live,now:Date.now(),watchlistIngest,ratingsRun,ratingsBlocked,discoveryReady:counts?counts.readyNow:null,resolverLease}),...(degraded.length?{degraded:[...degraded]}:{})};
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
const RUN_DIAGNOSTICS_SETTLE_KEY=ENRICHMENT_KEY+'run-diagnostics-settle.json';
const RUN_DIAGNOSTICS_SETTLE_LIMIT=100;
function diagnosticKey(id,at){return RUN_DIAGNOSTICS_PREFIX+String(9999999999999-Date.parse(at)).padStart(13,'0')+'-'+id+'.json';}
async function diagnosticCheckpoint(env,run,patch={}){
 if(run.runId.startsWith('blocked-'))return null; // Aggregate stop Events are not additional trigger attempts.
 const at=run.diagnosticStartedAt||run.createdAt,key=diagnosticKey(run.runId,at),old=await loadJSON(env,key),queue=await loadJSON(env,predictionQueueKey),lease=await loadJSON(env,RUNNER_LEASE_KEY),summary=runSummary(run);
 const value={runId:run.runId,trigger:run.trigger==='scheduled'?'scheduled':'manual',startedAt:at,endedAt:run.completedAt||null,state:run.status==='complete'?'completed':run.status==='partial'?'blocked':run.status||'running',startResult:old?.startResult||run.startResult||'running',stopReason:run.stopReason||run.reason||null,leaseAcquiredAt:old?.leaseAcquiredAt||run.leaseAcquiredAt||null,leaseExpiredAt:lease?.runId===run.runId?new Date(lease.expiresAt||Date.parse(old?.leaseExpiredAt||at)).toISOString():old?.leaseExpiredAt||null,lastHeartbeatAt:run.lastHeartbeatAt||old?.lastHeartbeatAt||null,firstNextAt:run.firstNextAt||old?.firstNextAt||null,firstSubmitAt:run.firstSubmitAt||old?.firstSubmitAt||null,added:summary.added,failed:summary.failed,hotRemaining:queue?.priorityCount??run.hotRemaining??null,coldRemaining:queue?.coldRemaining??run.coldRemaining??null,batchesProcessed:Math.max(0,(run.batchCount||1)-1)+(run.selectedIds?.length&&run.selectedIds.every(id=>run.results?.[id])?1:0),...patch,steps:Array.isArray(old?.steps)?old.steps.slice(-8):[],lastAttemptedStep:old?.lastAttemptedStep||null,lastCompletedStep:old?.lastCompletedStep||null,serverFault:old?.serverFault||null,callerFault:run.callerFault||old?.callerFault||null,itemValidation:run.itemValidation||old?.itemValidation||null,delivery:'unconfirmed'};
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
 const run=await checkedRun(env,row.runId);
 if(run&&['running','interrupted'].includes(run.status)){
  if(run.status==='interrupted'&&run.stopReason==='lease_expired'&&row.state==='interrupted')return;
  run.status='interrupted';run.recoverable=true;run.stopReason='lease_expired';run.reason='lease_expired';run.completedAt=run.completedAt||row.leaseExpiredAt;
  await saveJSON(env,runKey(run.runId),run);await diagnosticCheckpoint(env,run);return;
 }
 await saveJSON(env,itemKey,projectedDiagnostic(row,now));
}
async function settleExpiredDiagnostics(env,now=Date.now()){
 // One R2 list page per authorized start, with a durable resume cursor. A list/get/put error leaves the cursor
 // unchanged so the next start retries the same page; already-settled rows are no-ops. Admission of the new run
 // does not wait on a full history scan (AIR-415).
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
 for(const item of page.objects){const row=await loadJSON(env,item.key);if(row)rows.push(projectedDiagnostic(row));}
 return {runs:rows.sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt)||b.runId.localeCompare(a.runId)).slice(0,limit).map(presentDiagnostic)};
}
// AIR-417 / AIR-424. While an EPG publication holds or loads the Discovery authority, the catalog cannot be read and the queue cannot be rebuilt.
// That is a wait, not a storage failure: start answers 503 blocked `prediction_catalog_held`, keeps no lease and writes no stop Event.
// next, submit and complete of an owned run answer the same 503, keep the lease and do not stop. `cause` is the Discovery code that refused the read.
const CATALOG_HELD_CODES=['discovery_fence','discovery_incomplete'];
const catalogHeldResponse=(cause,extra={})=>json({status:'blocked',reason:'catalog_held',code:'prediction_catalog_held',cause,...extra,...scheduledRunFields()},503);
async function catalogHeldCause(env){
 if(typeof DiscoveryAuthority==='undefined')return null;
 const gate=await DiscoveryAuthority.readAuthority(env);
 return gate.held?'discovery_fence':gate.ready&&gate.transfer==='loading'?'discovery_incomplete':null;
}
function catalogHeldQueueError(error){return CATALOG_HELD_CODES.includes(error?.code)&&error.stage==='queue_refresh'?error:null;}
function ownedCatalogHeld(boundary,error,requestId,runId,extra={}){
 logPredictionFailure(boundary,error,requestId,runId);
 return catalogHeldResponse(error.code,{runId,leaseTtlMs:RUNNER_LEASE_TTL,...extra});
}
async function diagnosedStart(env,body,requestId){
 const runId=crypto.randomUUID(),at=new Date().toISOString(),shell={runId,createdAt:at,diagnosticStartedAt:at,trigger:body.trigger==='scheduled'?'scheduled':'manual',status:'starting',selectedIds:[],results:{},failures:{}};
 await diagnosticCheckpoint(env,shell,{startResult:'error'});
 const response=await observedPrediction(env,{...body,diagnosticRunId:runId},async()=>{
  const unsettled=await atStage('settle_previous',()=>settlePreviousRun(env));if(unsettled)return unsettled;
  const held=await atStage('catalog_gate',()=>catalogHeldCause(env));if(held)return catalogHeldResponse(held);
  const lease=await atStage('runner_lease',()=>runnerLease(env,runId,'acquire'));if(lease.status!=='owned')return json(lease);
  shell.leaseAcquiredAt=lease.heartbeatAt;shell.lastHeartbeatAt=lease.heartbeatAt;const previous=lease.recoveredRunId?await checkedRun(env,lease.recoveredRunId):null;shell.startResult=previous&&['running','interrupted'].includes(previous.status)?'recovered_stale_lease':'running';await diagnosticCheckpoint(env,shell,{state:'running',startResult:shell.startResult});
  try{const result=await atStage('writer_lease',()=>predictionWriter(env,async()=>{await settleExpiredDiagnostics(env);await deliverPendingEvents(env);return enrichmentStart(env,body,{...lease,diagnosticStartedAt:at,startResult:shell.startResult});}));if(result.status>=400)await runnerLease(env,runId,'release');return result;}catch(error){await runnerLease(env,runId,'release');if(error?.stage==='queue_refresh'&&CATALOG_HELD_CODES.includes(error?.code)){logPredictionFailure('start',error,requestId,runId);return catalogHeldResponse(error.code);}throw error;}
 },'start',requestId);
 const data=await response.clone().json();if(data.status!=='running'){shell.status=data.status==='already_running'?'completed':data.status==='noop'?'idle':'blocked';shell.completedAt=new Date().toISOString();shell.stopReason=data.stopReason||data.reason||(data.error?'storage_error':null);await diagnosticCheckpoint(env,shell,{startResult:['already_running','blocked','noop'].includes(data.status)?data.status:'error',leaseAcquiredAt:shell.leaseAcquiredAt||null,lastHeartbeatAt:shell.lastHeartbeatAt||null});}
 return response;
}
async function savePredictionRun(env,run){await saveJSON(env,runKey(run.runId),run);await saveJSON(env,ENRICHMENT_KEY+'latest-run.json',run);await diagnosticCheckpoint(env,run);}
async function enrichmentStart(env,body,acquired=null){
 const mode=body.mode||'queued';if(!['watchlist_available','watchlist_all'].includes(body?.scope)||(body.limit!==undefined&&(!Number.isInteger(body.limit)||body.limit<1))||!['queued','legacy'].includes(mode)||(body.batchSize!==undefined&&(!Number.isInteger(body.batchSize)||body.batchSize<1||body.batchSize>MAX_PREDICTION_BATCH)))return json({error:'Invalid scope, mode or batchSize'},400);
 if(body.capacity!==undefined&&(!isObject(body.capacity)||body.capacity.remainingPercent!==undefined&&(!Number.isFinite(body.capacity.remainingPercent)||body.capacity.remainingPercent<0||body.capacity.remainingPercent>100)))return json({error:'Invalid capacity'},400);
 const [profile,report,sync]=await Promise.all([loadJSON(env,profileKey),loadJSON(env,'programme.json'),loadJSON(env,'sync.json')]);if(!profile)return json({error:'Taste profile is not configured'},409);if(!report?.runId||!report?.films||!sync||sync.stage!=='complete'&&sync.runId===report.runId)return json({error:'No completed programme snapshot'},409);
 // The rebuild already read the programme, the catalog and the index of this generation; the start reuses them instead of reading each again
 // (AIR-417: three copies of the catalog and programme and two of the index in one request exceeded the isolate memory).
 const inputs={},queue=mode==='queued'?await atStage('queue_refresh',()=>currentPredictionQueue(env,report,profile,body.trigger==='scheduled'?'scheduled':'manual',{force:true,fallback:true,capture:inputs})):null,reused=mode==='queued'&&inputs.report?.runId===report.runId&&inputs.catalog!==undefined,legacyFilms=mode==='queued'?null:eligibleEnrichmentFilms(report),eligibleCount=mode==='queued'?(queue.hotCount||0)+(queue.coldCount||0):legacyFilms.length,plan=mode==='queued'?adaptivePredictionBatch(queue,body.capacity):null;
 // Explicit small nonlegacy diagnostics batches remain possible. The old scheduled 4 is a legacy hint, not a throughput cap.
 const batchSize=mode==='queued'?Math.min(plan.batchSize,body.batchSize!==undefined&&!(body.trigger==='scheduled'&&body.batchSize===4)?body.batchSize:MAX_PREDICTION_BATCH):legacyFilms.length;
 const previous=await loadJSON(env,ENRICHMENT_KEY+'latest-run.json');
 const runId=acquired?.runId||crypto.randomUUID(),lease=acquired||await runnerLease(env,runId,'acquire');if(lease.status!=='owned')return json({...lease,runner:predictionRunnerContract()});
 const recovered=lease.recoveredRunId?await checkedRun(env,lease.recoveredRunId):previous?.status==='running'?previous:null;
 if(recovered&&['running','interrupted'].includes(recovered.status)){recovered.status='interrupted';recovered.recoverable=true;recovered.reason='lease_expired';recovered.stopReason='lease_expired';recovered.completedAt=new Date().toISOString();recovered.recoveredByRunId=runId;await saveJSON(env,runKey(recovered.runId),recovered);await diagnosticCheckpoint(env,recovered);}

 const batchIds=mode==='queued'?queueBatchIds(queue,queueReadyIds(queue),batchSize):[],batchFilms=mode==='queued'&&batchIds.length?await atStage('queue_refresh',()=>readFilmsById(env,report,batchIds,reused?inputs.catalog||{}:undefined)):new Map(),selected=mode==='queued'?batchIds.map(id=>batchFilms.get(id)).filter(Boolean):body.limit===undefined?legacyFilms:legacyFilms.slice(0,body.limit);
 if(mode==='queued'&&!selected.length){await runnerLease(env,runId,'release');const at=new Date().toISOString(),remaining=queue.priorityCount+queue.coldRemaining,reason=plan.reason==='quota'?'quota':remaining?'retry_backoff':null,stage=reason?'blocked':'noop';const lastBatch={runId:null,trigger:body.trigger==='scheduled'?'scheduled':'manual',startedAt:at,finishedAt:at,stage,profileVersion:profile.version,batchSize:0,hotProcessed:0,coldProcessed:0,hotRemaining:queue.priorityCount,coldRemaining:queue.coldRemaining,checked:0,added:0,updated:0,failed:0,remaining,reason};await mutatePredictionQueue(env,current=>({...current,lastCheckAt:at,lastBatch}),'start_check');if(reason==='retry_backoff')await writeEvent(env,{id:'enrichment-blocked-'+Math.floor(Date.now()/3600000),type:'enrichment',at,queueSchemaVersion:3,...lastBatch,...scheduledRunFields()});return json({status:stage,...lastBatch,...scheduledRunFields()});}
 const states=await atStage('film_state',()=>Promise.all(selected.map(f=>readFilmState(env,f.id)))),baseline=Object.fromEntries(selected.map((f,i)=>[String(f.id),states[i].predictions?.current?.generatedAt||null])),freshness=await predictionFreshness(env,profile),pendingCount=mode==='queued'?queue.pending.length:states.filter((s,i)=>!freshness.state(s.predictions?.current,s.fingerprint,selected[i].genres)).length;

 const createdAt=new Date().toISOString(),run={runId,pipelineVersion:PREDICTION_PIPELINE_VERSION,status:'running',mode,trigger:body.trigger==='scheduled'?'scheduled':'manual',createdAt,diagnosticStartedAt:acquired?.diagnosticStartedAt||createdAt,leaseAcquiredAt:acquired?.heartbeatAt||createdAt,startResult:acquired?.startResult||(recovered?.recoverable?'recovered_stale_lease':'running'),lastActivityAt:createdAt,deadlineAt:null,lastHeartbeatAt:createdAt,batchCount:1,capacity:body.capacity||{},sourceProgrammeRunId:report.runId,tasteProfileVersion:profile.version,tasteProfileHash:profile.profileHash,fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,fingerprintPromptVersion:FINGERPRINT_PROMPT_VERSION,predictionPromptVersion:PREDICTION_PROMPT_VERSION,fingerprintRegistryDigest:freshness.registryDigest??(await fingerprintRegistryDigests()).registry,eligibleCount,batchSize:selected.length,adaptivePlan:plan,selectedIds:selected.map(f=>String(f.id)),selectionKind:Object.fromEntries(selected.map(f=>[String(f.id),mode==='queued'&&queue.priority[f.id]?.hot?'hot':'cold'])),baseline,failures:{},results:{}};
 await saveJSON(env,ENRICHMENT_KEY+'sources/'+run.runId+'.json',Object.fromEntries(selected.map(f=>[String(f.id),modelMetadata(f)])));await atStage('run_save',()=>savePredictionRun(env,run));await atStage('runner_started',()=>runnerStarted(env,run,!!recovered&&recovered.recoveredByRunId===runId||!!previous&&['running','partial'].includes(previous.status)&&previous.tasteProfileHash===profile.profileHash,queue,reused?inputs:null));return json({...runSummary(run),pendingCount,hotRemaining:queue?.priorityCount??null,coldRemaining:queue?.coldRemaining??null,...(queue?.queueStale?{queueStale:queue.queueStale}:{}),...scheduledRunFields(),runner:predictionRunnerContract()});
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
async function enrichmentNext(env,body,requestId){
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
  const report=await loadJSON(env,'programme.json');let queue;try{queue=await atStage('queue_refresh',()=>currentPredictionQueue(env,report,profile,'next_priority'));}catch(error){const held=catalogHeldQueueError(error);if(held)return ownedCatalogHeld('next',held,requestId,run.runId);throw error;}
  // Films of this run that are already current (a restored fingerprint, a repaired index entry, a submit whose queue write was lost) leave the stored queue now,
  // so they neither hold a slot nor hide the films behind them.
  const currentIds=run.selectedIds.filter((id,i)=>fresh(id,states[i]));
  if(currentIds.some(id=>queue.pending.includes(id)||queue.hotPending.includes(id)||queue.coldPending.includes(id)))queue=await mutatePredictionQueue(env,current=>{const next=settleQueueFilms(current,currentIds);if(next)next.trigger='next_priority';return next;},'next_priority')||queue;
  const completed=run.selectedIds.filter((id,i)=>fresh(id,states[i])||run.results?.[id]);
  let slots=Math.max(0,run.batchSize-completed.filter(id=>(run.batchIds||run.selectedIds).includes(id)).length),newBatch=false;
  if(!slots){const plan=adaptivePredictionBatch(queue,body.capacity||run.capacity);run.adaptivePlan=plan;run.batchSize=plan.batchSize;slots=plan.batchSize;run.batchIds=[];newBatch=true;}
  const ready=queueBatchIds(queue,queueReadyIds(queue).filter(id=>!run.failures[id]),slots);run.batchIds=[...new Set([...(run.batchIds||completed),...ready])];let selected=[...new Set([...(newBatch?[]:completed),...ready])];if(newBatch&&ready.length)run.batchCount++;
  run.hotRemaining=queue.priorityCount;run.coldRemaining=queue.coldRemaining;await runnerProgress(env,run,queue);await savePredictionRun(env,run);
  if(!ready.length){const reason=run.adaptivePlan?.reason==='quota'?'quota':queue.priorityCount+queue.coldRemaining?'eligible_queue_empty':'queue_empty';return json({runId:run.runId,items:[],mustComplete:true,stopReason:reason,hotRemaining:queue.priorityCount,coldRemaining:queue.coldRemaining});}
  if(selected.join('|')!==run.selectedIds.join('|')){
   let films=new Map();const needed=ready.filter(id=>!source[id]);if(needed.length){try{films=await atStage('queue_refresh',()=>readFilmsById(env,report,needed));}catch(error){const held=catalogHeldQueueError(error);if(held)return ownedCatalogHeld('next',held,requestId,run.runId);throw error;}}
   // A film the queue still lists but whose admission is gone (superseded between the queue write and this step) is dropped from the queue.
   const gone=needed.filter(id=>!films.has(id));if(gone.length){await mutatePredictionQueue(env,current=>settleQueueFilms(current,gone),'next_priority');selected=selected.filter(id=>!gone.includes(id));run.batchIds=run.batchIds.filter(id=>!gone.includes(id));}
   run.selectedIds=selected;for(const id of ready){if(!source[id]){const film=films.get(id);if(!film)continue;source[id]=modelMetadata(film);const s=await readFilmState(env,id);run.baseline[id]=s.predictions?.current?.generatedAt||null;}run.selectionKind[id]=queue.priority[id]?.hot?'hot':'cold';}
   await saveJSON(env,ENRICHMENT_KEY+'sources/'+run.runId+'.json',source);await savePredictionRun(env,run);states=await Promise.all(selected.map(id=>readFilmState(env,id)));
  }
 }
 const items=[];let pendingCount=0;
 for(let i=0;i<run.selectedIds.length;i++){const id=run.selectedIds[i],s=states[i];if(fresh(id,s)||run.failures[id])continue;pendingCount++;if(items.length>=requestSize)continue;const film=source[id];if(!film)continue;const requiredWork=freshness.fingerprintUsable(s.fingerprint,source[id]?.genres)?'prediction_only':'fingerprint_and_prediction',item={filmId:id,requiredWork};if(requiredWork==='prediction_only')item.fingerprint=s.fingerprint;else item.metadata=film;items.push(item);}
 return json({runId:run.runId,profile:profile.profile,profileVersion:profile.version,profileHash:profile.profileHash,fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,fingerprintPromptVersion:FINGERPRINT_PROMPT_VERSION,predictionPromptVersion:PREDICTION_PROMPT_VERSION,items,pendingCount,batchSize:run.batchSize,deadlineAt:run.deadlineAt||null,modelBatching:predictionRunnerContract().modelBatching});
}
async function enrichmentSubmit(env,body,requestId){
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
   if(item.fingerprint&&!usable(fingerprint)){const found=fingerprintIssues(item.fingerprint,source[id]);if(found.length){failureStage='parse_error';validationStage='fingerprint_schema';reportedBy='worker';issues=found;throw new Error('Invalid fingerprint');}fingerprint=await writeFingerprint(env,id,item.fingerprint,fingerprint,'generated');}
   if(!usable(fingerprint)){failureStage='parse_error';validationStage='fingerprint_missing';reportedBy='worker';issues=[{path:'fingerprint',code:'required'}];throw new Error('Current fingerprint required');}
   if(freshness.state(state.predictions?.current,fingerprint,source[id]?.genres)){await updateViewIndex(env,id,{prediction:state.predictions.current,fingerprintHash:fingerprint.fingerprintHash,fingerprint:fingerprintFacet(fingerprint,true),impactFeatures:fingerprintImpactFacet(fingerprint)});run.results[id] ||= 'already_current';delete run.failures[id];results.push({filmId:id,status:'already_current'});}
   // Lineage of a new prediction (AIR-12): the fingerprint's prompt version completes its identity, runId and trigger name the run
   // that produced it. Records written before carry none of the three; readers treat them as unknown, never as the current run.
   else{const found=predictionIssues(item.prediction);if(found.length){failureStage='parse_error';validationStage='prediction_schema';reportedBy='worker';issues=found;throw new Error('Invalid prediction');}const submitted={...item.prediction};delete submitted.confidenceAssessment;const at=new Date().toISOString(),generated={...submitted,filmId:id,generatedAt:at,tasteProfileVersion:profile.version,tasteProfileHash:profile.profileHash,fingerprintHash:fingerprint.fingerprintHash,fingerprintSchemaVersion:fingerprint.fingerprintSchemaVersion,fingerprintPromptVersion:fingerprint.fingerprintPromptVersion??1,predictionPromptVersion:PREDICTION_PROMPT_VERSION,runId:run.runId,trigger:run.trigger==='scheduled'?'scheduled':'manual',confidenceAssessment:assessPredictionConfidence({...fingerprint,fingerprintHash:fingerprint.fingerprintHash})},old=state.predictions?.current,history=[...(state.predictions?.history||[])];
    // The version object is written first (write-once, keyed by checksum); a crash before the bundle write leaves an unreferenced object and an unchanged bundle, never a pointer to a missing object.
    const prediction={...generated,...(await writePredictionVersion(env,id,generated))};
    if(old)history.push({...old,replacedAt:at});await saveJSON(env,filmKey(id)+'predictions.json',{current:prediction,history});await updateViewIndex(env,id,{prediction,fingerprintHash:fingerprint.fingerprintHash,fingerprint:fingerprintFacet(fingerprint,true),impactFeatures:fingerprintImpactFacet(fingerprint)});delete run.failures[id];run.results[id]=old?'recalculated':'created';results.push({filmId:id,status:run.results[id]});}
   if(['created','recalculated'].includes(run.results[id]))run.firstSubmitAt||=new Date().toISOString();run.formatFailureStreak=0;
  }catch(e){const at=new Date().toISOString(),retryable=failureStage==='parse_error',previous=await loadJSON(env,predictionQueueKey),attempts=(previous?.retries?.[id]?.attempts||0)+1,retryAt=Date.now()+Math.min(6*3600000,3600000*2**(attempts-1));
   const validation=validationStage?{stage:validationStage,reportedBy,issues}:null;
   run.failures[id]={kind:failureStage,scope:retryable?'item':'run',retryable:true,failedAt:at,retryAt,attempts,...(validation?{validation}:{})};run.results[id]='failed';if(run.mode==='queued')run.retryHeal='pending';results.push({filmId:id,status:retryable?'retryable_failure':'failed',error:failureStage,failureScope:retryable?'item':'run',retryable:true,retryAt,...(validation?{validation}:{})});
   if(retryable){run.formatFailureStreak=(run.formatFailureStreak||0)+1;if(run.formatFailureStreak>=5)run.systemicStopReason='format_error_storm';}else run.systemicStopReason=failureStage;
   if(validationStage){const stages=[...(run.itemValidation?.stages||[]),{stage:validationStage,reportedBy}].slice(-8);run.itemValidation={consecutive:run.formatFailureStreak||0,stages};}
  }
  run.lastActivityAt=new Date().toISOString();const renewed=await runnerLease(env,run.runId);if(renewed.status!=='owned')return json(renewed,409);run.lastHeartbeatAt=renewed.heartbeatAt;await savePredictionRun(env,run);
  // Retry state is persisted immediately, not postponed until the eventual run completion.
  if(run.failures[id]){const failure=run.failures[id];let record=null;
   await mutatePredictionQueue(env,queue=>{queue.retries||={};const merged=mergeRetryRecord(queue.retries[id],failure,run.runId);if(merged===queue.retries[id])return null;queue.retries[id]=record=merged;return queue;},'submit_failure');
   // A concurrent record of the same film (another run's) can only raise attempts and retryAt; the run and the answer follow it.
   if(record&&(record.attempts!==failure.attempts||record.retryAt!==failure.retryAt)){failure.attempts=record.attempts;failure.retryAt=record.retryAt;const answer=results.findLast(r=>r.filmId===id);if(answer?.retryAt!==undefined)answer.retryAt=record.retryAt;await savePredictionRun(env,run);}}
  if(run.systemicStopReason)break;
 }
 let queue=null;if(run.mode==='queued'){const settled=results.filter(r=>SETTLED_STATUSES.includes(r.status)).map(r=>r.filmId);try{queue=await atStage('queue_refresh',async()=>{const stored=await currentPredictionQueue(env,await loadJSON(env,'programme.json'),profile,'batch_progress');return stored&&settled.length?await mutatePredictionQueue(env,current=>{const next=settleQueueFilms(current,settled);if(next)next.trigger='batch_progress';return next;},'batch_progress')||stored:stored;});}catch(error){const held=catalogHeldQueueError(error);if(held)return ownedCatalogHeld('submit',held,requestId,run.runId,{results,committed:results.some(r=>['created','recalculated','already_current'].includes(r.status)),identicalSubmit:'idempotent'});throw error;}}await runnerProgress(env,run,queue);
 return json({...runSummary(run),results,mustComplete:!!run.systemicStopReason,stopReason:run.systemicStopReason||null,remaining:queue?.pending.length??null,hotRemaining:queue?.priorityCount??null,coldRemaining:queue?.coldRemaining??null,...scheduledRunFields()});
}
async function enrichmentComplete(env,body,requestId){
 const run=await checkedRun(env,body?.runId);if(!run)return json({error:'Unknown run'},404);
 if(run.status==='complete'||run.status==='partial'){if(run.event)await writeEvent(env,run.event);else await writeEvent(env,{id:'enrichment-'+run.runId,type:'enrichment',at:run.completedAt,...run.counts});await runnerLease(env,run.runId,'release');return json({runId:run.runId,status:run.status,counts:run.counts,...(run.event||{})});}
 const fault=readCallerFault(body);if(fault.rejected)return json({error:'Invalid fault'},400);
 const faultReason=typeof body.reason==='string'&&!NORMAL_COMPLETE.includes(body.reason)?systemicReason(body.reason):null;
 if(fault.value&&!FAULT_REASONS.includes(faultReason))return json({error:'Fault requires an external stop reason'},400);
 const attributed=externalAttribution(faultReason,fault.value);if(attributed)run.callerFault=attributed;
 const lease=await runnerLease(env,run.runId);if(lease.status!=='owned')return json(lease,409);run.lastHeartbeatAt=lease.heartbeatAt;
 if(body.reason&&!NORMAL_COMPLETE.includes(body.reason)){return json(await recordRunStop(env,run.runId,systemicReason(body.reason),{callerFault:run.callerFault||null}));}
 const profile=await loadJSON(env,profileKey);if(profile?.profileHash!==run.tasteProfileHash&&!body.reason)return json({error:'Profile changed; start a new run'},409);
 if(!body.reason&&await runContractChanged(run))return contractChangedResponse();
 if(run.mode==='queued'&&(!body.reason||['queue_empty','eligible_queue_empty','parse_error'].includes(body.reason))&&!run.systemicStopReason){let queue;try{queue=await atStage('queue_refresh',async()=>currentPredictionQueue(env,await loadJSON(env,'programme.json'),profile,'completion_check'));}catch(error){const held=catalogHeldQueueError(error);if(held)return ownedCatalogHeld('complete',held,requestId,run.runId);throw error;}if(queueReadyIds(queue).some(id=>!run.failures[id]))return json({error:'Queue not empty; continue next',runId:run.runId,hotRemaining:queue.priorityCount,coldRemaining:queue.coldRemaining},409);}
 const states=await Promise.all(run.selectedIds.map(id=>readFilmState(env,id)));let created=0,recalculated=0,pending=0;
 const freshness=await predictionFreshness(env,profile),source=freshness.needsGenres?await loadJSON(env,ENRICHMENT_KEY+'sources/'+run.runId+'.json')||{}:{};
 for(let i=0;i<states.length;i++){const s=states[i],p=s.predictions?.current,id=run.selectedIds[i];if(p?.generatedAt&&p.generatedAt!==run.baseline[id]&&p.tasteProfileHash===run.tasteProfileHash&&p.predictionPromptVersion===run.predictionPromptVersion){run.baseline[id]?recalculated++:created++;if(!['created','recalculated'].includes(run.results?.[id]))run.results[id]=run.baseline[id]?'recalculated':'created';}else if(!run.failures[id]&&!freshness.state(p,s.fingerprint,source[id]?.genres))pending++;}
 created=Object.values(run.results).filter(x=>x==='created').length;recalculated=Object.values(run.results).filter(x=>x==='recalculated').length;const failed=Object.keys(run.failures).length;run.counts={created,recalculated,failed,pending};run.reason=['queue_empty','eligible_queue_empty','parse_error'].includes(body.reason)?null:safePredictionReason(body.reason||run.interruption);run.reason=run.systemicStopReason||run.reason;run.stopReason=run.reason||(failed?'eligible_queue_empty':pending?'external_termination':'queue_empty');run.status=pending||run.reason?'partial':'complete';run.completedAt=new Date().toISOString();
 const summary=runSummary(run);let hotRemaining=null,coldRemaining=null,remaining=pending;
 if(run.mode==='queued'){
  // Retries, the batch summary and the counter go into the rebuild's own conditional write; the counter moves once per run.
  const amend=queue=>{recordRunRetries(queue,run);if(queue.lastBatch?.runId!==run.runId)queue.metrics.hotProcessedTotal+=summary.hotProcessed;queue.lastBatch={runId:run.runId,trigger:run.trigger,startedAt:run.createdAt,finishedAt:run.completedAt,stage:run.status,profileVersion:run.tasteProfileVersion,batchSize:run.batchSize,hotProcessed:summary.hotProcessed,coldProcessed:summary.coldProcessed,checked:summary.checked,added:created,updated:recalculated,failed,remaining:queue.pending.length,hotRemaining:queue.priorityCount,coldRemaining:queue.coldRemaining,reason:run.reason,perFilmMs:created+recalculated?(Date.parse(run.completedAt)-Date.parse(run.createdAt))/(created+recalculated):null};queue.lastCheckAt=run.completedAt;return queue;};
  const succeeded=Object.entries(run.results||{}).filter(([,status])=>SETTLED_STATUSES.includes(status)).map(([id])=>id);let queue;try{queue=await atStage('queue_refresh',async()=>{const stored=await currentPredictionQueue(env,await loadJSON(env,'programme.json'),profile,'batch_complete');return stored?await mutatePredictionQueue(env,current=>{settleQueueFilms(current,succeeded);current.trigger='batch_complete';return amend(current);},'batch_complete'):null;});}catch(error){const held=catalogHeldQueueError(error);if(held)return ownedCatalogHeld('complete',held,requestId,run.runId);throw error;}if(queue)delete run.retryHeal;remaining=queue?.pending.length??pending;hotRemaining=queue?.priorityCount??null;coldRemaining=queue?.coldRemaining??null;
  // A normal completion is "drained" only when the refreshed queue has no outstanding film; otherwise work remains that
  // this run could not take (deferred by retry or waiting behind hot). Run completion and a drained queue stay separate.
  if(queue&&!run.reason&&!pending)run.stopReason=queue.priorityCount+queue.coldRemaining?'eligible_queue_empty':'queue_empty';
 }
 const snapshot=await predictionEventSnapshot(env,run.mode==='queued'?await loadJSON(env,predictionQueueKey):null,run.batchSize),delta=predictionEventDelta(run,summary,snapshot),event={id:'enrichment-'+run.runId,type:'enrichment',at:run.completedAt,...run.counts,checked:summary.checked,added:created,updated:recalculated,batchSize:run.batchSize,hotProcessed:summary.hotProcessed,coldProcessed:summary.coldProcessed,remaining,hotRemaining,coldRemaining,queueSchemaVersion:6,batchCount:run.batchCount,batchesProcessed:predictionBatchesProcessed(run),delta,snapshot,lastHeartbeatAt:run.lastHeartbeatAt,stopReason:run.stopReason,trigger:run.trigger,stage:run.status,reason:run.reason,...scheduledRunFields()};run.event=event;await savePredictionRun(env,run);await writeEvent(env,event);await runnerLease(env,run.runId,'release');return json({runId:run.runId,status:run.status,counts:run.counts,...event});
}
async function enrichmentStatus(env){const recent=(await diagnosticHistory(env,20)).runs;const [profile,run,report,queue,discoveryRead,lease,eventOutbox]=await Promise.all([loadJSON(env,profileKey),loadJSON(env,ENRICHMENT_KEY+'latest-run.json'),loadJSON(env,'programme.json'),queueStatus(env),loadJSON(env,'epg/discovery-status.json').then(value=>({value}),()=>({value:null,unavailable:true})),loadJSON(env,RUNNER_LEASE_KEY),eventOutboxStatus(env)]);const summary=run?runSummary(run):null,state=run?.status==='running'?(lease?.runId===run.runId&&lease.expiresAt>Date.now()?'running':'blocked'):run?.status==='partial'?'blocked':run?.status==='complete'?'completed':'idle',live={state,runId:run?.runId||null,startedAt:run?.createdAt||null,lastHeartbeatAt:state==='running'&&lease&&lease.runId===run?.runId?lease.heartbeatAt:run?.lastHeartbeatAt||null,added:summary?.added||0,failed:summary?.failed||0,hotRemaining:queue?.hotRemaining??null,coldRemaining:queue?.coldRemaining??null,currentBatchSize:state==='running'?run.batchSize??null:null};return {...live,diagnostics:compactDiagnostics(recent.find(row=>row.runId===run?.runId)||recent[0]||null),live,currentRun:state==='running'?live:null,recentRuns:recent.filter(r=>r.state!=='running').slice(0,10),profileVersion:profile?.version||null,fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,fingerprintPromptVersion:FINGERPRINT_PROMPT_VERSION,predictionPromptVersion:PREDICTION_PROMPT_VERSION,compatibility:{profileMode:PREDICTION_PROFILE_MODE,fingerprintMode:PREDICTION_FINGERPRINT_MODE},lastRun:run?{...runSummary(run),counts:run.counts||null,failures:run.failures,reason:run.reason||null,completedAt:run.completedAt||null}:null,selectedCount:queue?(queue.hotCount||0)+(queue.coldCount||0):report?eligibleEnrichmentFilms(report).length:0,pendingCount:queue?.pendingCount??null,discovery:discoveryRead.value||null,...(discoveryRead.unavailable?{discoveryStatus:'unavailable'}:{}),queue,eventOutbox};}
async function enrichmentView(env){const [profile,stored]=await Promise.all([loadJSON(env,profileKey),readViewIndex(env)]),index=typeof PredictionD1==='undefined'?stored:await PredictionD1.overlayIndex(env,stored,canonicalMoodFacet),freshness=await predictionFreshness(env,profile);
 // Genres feed only the selective rules, so the programme and catalog are read only when one of them is on.
 const films=freshness.needsGenres?await (async()=>{const pinned=await pinEpg(env),[report,catalog]=await Promise.all([loadJSON(pinned,'programme.json'),loadJSON(pinned,'epg/discovered-films.json')]);return new Map(allEnrichmentFilms(report||{films:[]},catalog).map(f=>[String(f.id),f]));})():null;return {moodVocabulary:{version:MOOD_MAPPING_VERSION,labels:MOOD_LABELS,groups:MOOD_GROUPS},profile:profile?{version:profile.version,updatedAt:profile.updatedAt}:null,compatibility:{profileMode:freshness.mode,fingerprintMode:freshness.fingerprintMode,...fingerprintTarget()},films:Object.fromEntries(Object.entries(index||{}).map(([id,item])=>{const p=item.prediction,f=item.fingerprint,facet=canonicalMoodFacet(f,p);return [id,{moodIds:facet.moodIds,moodGroups:moodPresentationGroups(facet.mapping),fingerprint:f&&f.fingerprintHash===item.fingerprintHash?{plotMechanics:f.plotMechanics||[],moodIds:facet.moodIds,execution:executionFacet(f.execution)}:null,prediction:p?{predictedRating:p.predictedRating,probability4Plus:p.probability4Plus,confidence:p.confidence,matchSignals:p.matchSignals,mainRisk:p.mainRisk,moodIds:facet.moodIds,...(Object.hasOwn(p,'confidenceAssessment')?{confidenceAssessment:p.confidenceAssessment,fingerprintHash:p.fingerprintHash??null}:{}),stale:!freshness.indexed(item,films?.get(id))}:null,actualRating:item.actualRating??null,watched:item.watched===true?true:item.watched===false?false:null}];}))};}

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
async function filmHistoryRoute(env,url){
 const filmId=url.searchParams.get('filmId');
 if(typeof filmId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(filmId))return json({error:'filmId must be 1–80 letters, digits, "_" or "-"'},400);
 const page=filmHistoryPageRequest(url.searchParams);if(page.error)return json({error:page.error},400);
 const read=async key=>{const object=await env.BUCKET.get(key);if(!object)return {status:'missing',etag:null,value:null};try{return {status:'recorded',etag:object.etag,value:await object.json()};}catch{return {status:'unreadable',etag:object.etag,value:null};}};
 const bundle=await read(filmKey(filmId)+'predictions.json');
 const tmdb=/^tmdb_([1-9]\d{0,11})$/.exec(filmId),alias=tmdb?'tmdb:'+tmdb[1]:'letterboxd:'+filmId;
 const links=await read(LetterboxdFacts.FACTS_KEYS.links);
 let factKey=links.value?.[alias]||null,fact={status:'missing',etag:null,value:null};
 // Diary lid candidates: the requested id when it is a lid, and the lid of every fact record read (both sides of a convergence).
 const lidCandidates=tmdb?[]:[{lid:filmId,via:'requested_id'}];
 if(factKey){
  fact=await read(LetterboxdFacts.recordKey(factKey));
  if(fact.value?.redirectTo){factKey=fact.value.redirectTo;fact=await read(LetterboxdFacts.recordKey(factKey));}
  else if(fact.value?.migrating?.to){const target=await read(LetterboxdFacts.recordKey(fact.value.migrating.to));lidCandidates.push({lid:fact.value.links?.letterboxd,via:'fact_record'});fact={status:fact.status,etag:fact.etag+'+'+target.etag,value:LetterboxdFacts.overlay(fact.value,target.value)};}
 }
 const factLinks=fact.value?.links||{},filmIds=[...new Set([filmId,...(factLinks.letterboxd?[String(factLinks.letterboxd)]:[]),...(factLinks.tmdb?['tmdb_'+factLinks.tmdb]:[])])];
 if(factLinks.letterboxd)lidCandidates.push({lid:String(factLinks.letterboxd),via:'fact_record'});
 const [legacy,profile,diaryHistory,diaryState]=await Promise.all([read(ratingObservationsKey),read(profileKey),read(LetterboxdDiary.KEYS.history),read(LetterboxdDiary.KEYS.state)]);
 // The Diary history joins the digest only once it exists, so cursors of a film without one keep their earlier form.
 const digest=(await textSha256([bundle.etag,fact.etag,legacy.etag,...(diaryHistory.status==='missing'?[]:[diaryHistory.etag])].map(value=>value||'-').join('|'))).slice(0,16);
 if(page.digest&&page.digest!==digest)return json({error:'history_changed',detail:'The stored history changed since this cursor was issued; start again without a cursor.'},409);
 const link=diaryLink(lidCandidates);
 const built=buildFilmHistory({filmId,filmIds,bundle:bundle.value,factRecord:fact.value,legacyLog:legacy.value,profile:profile.value,diary:{history:diaryHistory.value,link}});
 if(diaryHistory.status!=='recorded')built.notes.push('diary_history_'+diaryHistory.status);
 const coverage=diaryState.value?.coverage||null,diaryComplete=diaryState.value?.lastOutcome==='complete'&&coverage?.reachedEnd===true&&!diaryState.value?.resumePage;
 if(diaryHistory.status==='recorded'&&!diaryComplete)built.notes.push('diary_coverage_partial');
 const diaryEntries=Object.values(diaryHistory.value?.entries||{});
 built.current.diary=link.status==='linked'&&diaryHistory.status==='recorded'?{lid:link.lid,...(LetterboxdDiary.summarize({entries:diaryEntries.filter(entry=>entry?.identity?.type==='letterboxd_lid'&&entry.identity.value===link.lid)})[link.lid]||{viewingCount:0,viewingCountExact:true,lastWatchedAt:null,rewatches:0,rewatchesExact:true})}:null;
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
 const partial=[bundle,fact,legacy,diaryHistory].some(source=>source.status==='unreadable')||slice.some(event=>event.type==='prediction'&&['missing','mismatch','invalid'].includes(event.version.status));
 const next=page.offset+page.limit<built.events.length?String(page.offset+page.limit)+'.'+digest:null;
 return json({schemaVersion:FILM_HISTORY_SCHEMA_VERSION,filmId,readAt:new Date().toISOString(),
  snapshot:{profile:profile.value?{version:profile.value.version??null,profileHash:profile.value.profileHash??null}:null,sources:{predictions:{status:bundle.status},facts:{status:factKey?fact.status:'missing',factKey},legacyRatingLog:{status:legacy.status},
   diary:{status:diaryHistory.status,link,unresolvedEntries:diaryEntries.filter(entry=>!entry?.identity).length,
    state:diaryState.value?{lastOutcome:diaryState.value.lastOutcome??null,lastSuccessAt:diaryState.value.lastSuccessAt??null,coverage,resumePage:diaryState.value.resumePage??null}:null}}},
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
  await refreshPredictionQueue(env,report,'epg_scan');const presented=await presentQueuedDiscovery(env,await queueDiscovery(env,'scan_committed',report.runId));return json({programmeRunId:report.runId,candidates:items.length,newCandidates:items.length-(old?.items?.length||0),scanned:result.stats.scanned,...presented});
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
 if(path==='/api/enrichment/queue/reconcile'&&request.method==='POST'){const report=await loadJSON(env,'programme.json');let queue;try{queue=await refreshPredictionQueue(env,report,'manual_reconcile');}catch(e){if(e?.name==='PredictionQueueConflictError')return json({error:'Prediction queue changed during write; read it again',code:e.code},409);throw e;}return queue?json(await queueStatus(env)):json({error:'Programme or taste profile unavailable'},409);}
 if(path==='/api/enrichment/queue/status'&&request.method==='GET')return json(await queueStatus(env)||{status:'not_initialized',pendingCount:null,...scheduledRunFields()});
 if(path==='/api/enrichment/footer/status'&&request.method==='GET')return json(await footerStatus(env));
 if(path==='/api/enrichment/next'&&request.method==='POST')return observedPrediction(env,body,()=>predictionWriter(env,()=>enrichmentNext(env,body,requestId)),'next',requestId);
 if(path==='/api/enrichment/submit'&&request.method==='POST')return observedPrediction(env,body,()=>predictionWriter(env,()=>enrichmentSubmit(env,body,requestId)),'submit',requestId);
 if(path==='/api/enrichment/complete'&&request.method==='POST')return observedPrediction(env,body,()=>predictionWriter(env,()=>enrichmentComplete(env,body,requestId)),'complete',requestId);
 if(path==='/api/enrichment/status'&&request.method==='GET')return json(await enrichmentStatus(env));
 if(path==='/api/enrichment/moods/diagnostics'&&request.method==='GET')return json(moodDiagnostics(await loadJSON(env,ENRICHMENT_KEY+'view-index.json')));
 if(path==='/api/enrichment/moods/backfill'&&request.method==='POST')return predictionWriter(env,()=>moodBackfill(env,body));
 if(path==='/api/enrichment/schema'&&request.method==='GET')return json({profile:{schemaVersion:1,required:['ratingScale','positiveSignals','negativeSignals','characterLogic','pace','payoffEnding','genrePreferences','comedyPreferences','horrorPreferences','scifiAdventurePreferences','actionPreferences','anchorFilms','hardSkips','calibration'],textFields:['ratingScale','characterLogic','pace','payoffEnding','genrePreferences','comedyPreferences','horrorPreferences','scifiAdventurePreferences','actionPreferences','calibration'],listFields:['positiveSignals','negativeSignals','hardSkips'],anchorFilms:{title:'string',rating:'0.5…5.0 in 0.5 steps',reason:'string'}},fingerprint:{fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,plotMechanics:MECHANICS,execution:EXECUTION,requiredExecution:GENERAL_EXECUTION,moodLabels:'2–4 short labels, preferably canonical vocabulary labels; raw input preserved and mapped at write',moodVocabulary:MOOD_LABELS,moodMapping:{version:MOOD_MAPPING_VERSION,groups:MOOD_GROUPS},strengths:'short string array',risks:'short string array',confidence:CONFIDENCE,sourceBasis:SOURCE_BASIS,sourceRefs:'URL or model_knowledge',evidence:'optional; see contract.fingerprint.evidence. Omitting the key keeps a legacy fingerprint'},prediction:{predictedRating:'0.5…5.0 in 0.5 steps',probability4Plus:'number 0…1',confidence:CONFIDENCE,matchSignals:'0–3 short strings',mainRisk:'one short string or null',moodLabels:'2–4 short labels, preferably canonical vocabulary labels; raw input preserved and mapped at write',moodVocabulary:MOOD_LABELS,moodMapping:{version:MOOD_MAPPING_VERSION,groups:MOOD_GROUPS}},contract:schemaContract(),rules:['Do not infer execution quality from premise alone; use unknown if evidence is insufficient','Do not use or request actual user rating for the target film','Check the fingerprint and prediction against contract before prediction_submit: every required execution dimension present, every enum value from its list (payoff and ending_quality use weak, mixed, strong, unknown, not medium; hero_vulnerability uses low, mixed, high, unknown), moodLabels 2–4 labels. A rejected item returns results[].validation.issues with the field path and code.']});
 if(path==='/api/enrichment/view'&&request.method==='GET')return json(await enrichmentView(env));
 if(path==='/api/enrichment/fingerprint-view/backfill'&&request.method==='POST')return backfillFingerprintView(env,body);
 if(path==='/api/enrichment/actual-ratings'&&request.method==='PUT'){if(!Array.isArray(body.items)||body.items.length>100)return json({error:'Expected items (max 100)'},400);const results=[];for(const item of body.items){const id=String(item?.filmId||''),rating=item?.rating;if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id)||!(rating===null||Number.isFinite(rating)&&rating>=.5&&rating<=5&&rating*2%1===0)){results.push({filmId:id,error:'Invalid film or rating'});continue;}const updatedAt=new Date().toISOString();const facts=await LetterboxdFacts.recordFilmFacts(env,id,{rating},{observedAt:updatedAt,source:'owner'});if(facts.conflict){results.push({filmId:id,error:'Identity conflict; recorded for review'});continue;}if(!facts.accepted||facts.record.rating?.value!==rating){results.push({filmId:id,status:'older',rating:facts.record.rating?.value??null});continue;}await saveActualMirror(env,filmKey(id)+'actual.json',{rating,source:'letterboxd',updatedAt});results.push({filmId:id,status:'saved'});}return json({results});}
 if(path==='/api/enrichment/ratings/backfill'&&request.method==='POST')return ratingsBackfill(env,body);
 return json({error:'Not found'},404);
}
