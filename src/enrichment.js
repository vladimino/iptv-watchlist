
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
async function moodBackfill(env,body){if(body.limit!==undefined&&(!Number.isInteger(body.limit)||body.limit<1||body.limit>100))return json({error:'Invalid limit'},400);const cursor=body.cursor||undefined;if(cursor&&typeof cursor!=='string')return json({error:'Invalid cursor'},400);const page=await env.BUCKET.list({prefix:ENRICHMENT_KEY+'films/',limit:Math.min(body.limit||12,12),...(cursor?{cursor}:{})});const ids=[...new Set(page.objects.filter(o=>/\/(fingerprint|predictions)\.json$/.test(o.key)).map(o=>decodeURIComponent(o.key.split('/')[2])))];const index=await loadJSON(env,ENRICHMENT_KEY+'view-index.json')||{};await Promise.all(ids.map(async id=>{const state=await readFilmState(env,id),facet={...canonicalMoodFacet(state.fingerprint,state.predictions?.current),historyMoodFacets:(state.predictions?.history||[]).map(p=>({generatedAt:p.generatedAt||null,...canonicalMoodFacet(null,p)}))};await saveJSON(env,filmKey(id)+'mood-facet.json',facet);index[id]={...(index[id]||{}),...(state.fingerprint?{fingerprintHash:state.fingerprint.fingerprintHash,fingerprint:fingerprintFacet(state.fingerprint)}:{}),...(state.predictions?.current?{prediction:state.predictions.current}:{}),moodFacet:facet};}));await saveJSON(env,ENRICHMENT_KEY+'view-index.json',index);const result={mappingVersion:MOOD_MAPPING_VERSION,checked:ids.length,nextCursor:page.truncated?page.cursor:null,done:!page.truncated};if(result.done)await saveJSON(env,ENRICHMENT_KEY+'diagnostics/moods.json',{...moodDiagnostics(index),completedAt:new Date().toISOString()});return json(result);}

// Independent R2 namespace: no enrichment write touches programme, watchlist or sync.
const FINGERPRINT_SCHEMA_VERSION=1;
const PREDICTION_PROMPT_VERSION=1;
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
const MECHANICS=['heist','scam','investigation','mystery','chase_escape','rescue','escort_protection','survival','siege','ticking_clock','expedition_discovery','puzzle','plan_counterplan','multi_party_conflict'];
const EXECUTION={plot_engine:['weak','medium','strong','unknown'],pace:['slow','medium','fast','variable','unknown'],stakes:['low','medium','high','unknown'],decision_logic:['weak','mixed','strong','unknown'],protagonist_competence:['low','mixed','high','unknown'],opposition_competence:['low','mixed','high','not_applicable','unknown'],problem_solving:['weak','medium','strong','unknown'],plan_counterplan_strength:['none','weak','medium','strong','unknown'],multi_party_goals:['none','weak','medium','strong','unknown'],chemistry:['weak','medium','strong','unknown'],payoff:['weak','mixed','strong','unknown'],ending_quality:['weak','mixed','strong','unknown'],technical_plausibility:['weak','mixed','strong','not_applicable','unknown'],action_readability:['weak','mixed','strong','unknown'],hero_vulnerability:['low','mixed','high','unknown'],comedy_stupidity_for_gags:['low','mixed','high','unknown'],comedy_gross_out:['low','mixed','high','unknown'],horror_rule_consistency:['weak','mixed','strong','unknown'],horror_threat_causality:['weak','mixed','strong','unknown'],scifi_plot_driven_concept:['weak','medium','strong','unknown'],adventure_discovery_strength:['weak','medium','strong','unknown']};
function validateFingerprint(f){
 if(!isObject(f)||f.fingerprintSchemaVersion!==FINGERPRINT_SCHEMA_VERSION)return 'Invalid fingerprint schema';
 if(!Array.isArray(f.plotMechanics)||f.plotMechanics.some(m=>!MECHANICS.includes(m))||!isObject(f.execution))return 'Invalid fingerprint dimensions';
 for(const [key,values] of Object.entries(EXECUTION))if((key in f.execution||!['action_readability','hero_vulnerability','comedy_stupidity_for_gags','comedy_gross_out','horror_rule_consistency','horror_threat_causality','scifi_plot_driven_concept','adventure_discovery_strength'].includes(key))&&!oneOf(f.execution[key],values))return 'Invalid execution: '+key;
 if(!Array.isArray(f.moodLabels)||f.moodLabels.length<2||f.moodLabels.length>4||!f.moodLabels.every(x=>isText(x,45)))return 'Invalid moodLabels';
 if(!isTextList(f.strengths,8)||!isTextList(f.risks,8)||!oneOf(f.confidence,['low','medium','high'])||!oneOf(f.sourceBasis,['metadata','model_knowledge','web_research','mixed']))return 'Invalid fingerprint evidence';
 if(!Array.isArray(f.sourceRefs)||f.sourceRefs.length>8||f.sourceRefs.some(x=>typeof x!=='string'||x.length>500||(!/^https:\/\//.test(x)&&x!=='model_knowledge')))return 'Invalid sourceRefs';
 if(JSON.stringify(f).length>12000)return 'Fingerprint too large';return null;
}
function validatePrediction(p){
 if(!isObject(p)||!Number.isFinite(p.predictedRating)||p.predictedRating<.5||p.predictedRating>5||p.predictedRating*2%1!==0)return 'Invalid predictedRating';
 if(!Number.isFinite(p.probability4Plus)||p.probability4Plus<0||p.probability4Plus>1||!oneOf(p.confidence,['low','medium','high']))return 'Invalid probability or confidence';
 if(!isTextList(p.matchSignals,3)||p.matchSignals.some(x=>x.length>220)||!(p.mainRisk===null||p.mainRisk===undefined||isText(p.mainRisk,220)))return 'Invalid matchSignals or mainRisk';
 if(!Array.isArray(p.moodLabels)||p.moodLabels.length<2||p.moodLabels.length>4||!p.moodLabels.every(x=>isText(x,45)))return 'Invalid moodLabels';return null;
}
const fingerprintCurrent=f=>!!f&&f.fingerprintSchemaVersion===FINGERPRINT_SCHEMA_VERSION&&!f.invalidatedAt;
const fingerprintFacet=f=>fingerprintCurrent(f)?{plotMechanics:f.plotMechanics||[],moodLabels:f.moodLabels||[],fingerprintHash:f.fingerprintHash}:null;
const predictionCurrent=(p,profile,f)=>!!p&&!!profile&&fingerprintCurrent(f)&&p.tasteProfileVersion===profile.version&&p.tasteProfileHash===profile.profileHash&&p.fingerprintHash===f.fingerprintHash&&p.fingerprintSchemaVersion===FINGERPRINT_SCHEMA_VERSION&&p.predictionPromptVersion===PREDICTION_PROMPT_VERSION;
function publicPrediction(p,profile,f){return predictionCurrent(p,profile,f)?{predictedRating:p.predictedRating,probability4Plus:p.probability4Plus,confidence:p.confidence,matchSignals:p.matchSignals,mainRisk:p.mainRisk,moodLabels:p.moodLabels}:null;}
async function readFilmState(env,id){const key=filmKey(id);const [fingerprint,predictions]=await Promise.all([loadJSON(env,key+'fingerprint.json'),loadJSON(env,key+'predictions.json')]);return {fingerprint,predictions};}
async function updateViewIndex(env,id,changes){const key=ENRICHMENT_KEY+'view-index.json',index=await loadJSON(env,key)||{};index[id]={...(index[id]||{}),...changes};index[id].moodFacet=canonicalMoodFacet(index[id].fingerprint,index[id].prediction);await saveJSON(env,filmKey(id)+"mood-facet.json",index[id].moodFacet);await saveJSON(env,key,index);}
async function ensureInitialRatings(env){
 const key=ENRICHMENT_KEY+'view-index.json',index=await loadJSON(env,key)||{};
 let changed=false;
 for(const [id,rating] of Object.entries(typeof INITIAL_PERSONAL_RATINGS==='undefined'?{}:INITIAL_PERSONAL_RATINGS)){
  if(!Object.hasOwn(index[id]||{},'actualRating')){index[id]={...(index[id]||{}),actualRating:rating};changed=true;}
 }
 if(changed)await saveJSON(env,key,index);
 return index;
}
function parsePersonalRating(html,filmUrl){
 for(const script of html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)){
  let value;try{value=JSON.parse(script[1].replace(/\/\*[\s\S]*?\*\//g,''));}catch{continue;}
  const author=Array.isArray(value.author)?value.author:[value.author];
  if(value['@type']!=='Review'||!author.some(a=>a?.sameAs==='https://letterboxd.com/demo-user/')||value.itemReviewed?.sameAs!==filmUrl)continue;
  const rating=Number(value.reviewRating?.ratingValue);if(Number.isFinite(rating)&&rating>=.5&&rating<=5&&rating*2%1===0)return rating;
 }
 return null;
}
async function refreshPersonalRating(env,film){
 const id=String(film.id),match=String(film.url||'').match(/^https:\/\/letterboxd\.com\/film\/([a-z0-9-]+)\/$/);if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id)||!match)throw new Error('Invalid Letterboxd film identity');
 const sourceUrl='https://letterboxd.com/demo-user/film/'+match[1]+'/';let response;
 try{response=await fetch(sourceUrl,{headers:{'User-Agent':'Mozilla/5.0 (compatible; WatchlistAirtime/1.0)','Accept':'text/html'},signal:AbortSignal.timeout(15000)});}catch(e){throw new Error('Rating lookup failed: '+e.message);}
 if(response.status===404)return {filmId:id,status:'not_found'};if(!response.ok)throw new Error('Rating source HTTP '+response.status);
 const rating=parsePersonalRating(await response.text(),film.url);if(rating===null)return {filmId:id,status:'not_rated'};
 const [previous,index]=await Promise.all([loadJSON(env,filmKey(id)+'actual.json'),ensureInitialRatings(env)]),before=index[id]?.actualRating??null;
 if(previous?.rating===rating&&before===rating)return {filmId:id,status:'unchanged',rating};
 if(before!==rating)await recordRatingObservation(env,{filmId:id,before,after:rating,observedAt:new Date().toISOString(),source:'letterboxd_member_film',sourceUrl});
 if(previous?.rating!==rating)await saveJSON(env,filmKey(id)+'actual.json',{rating,source:'letterboxd',sourceUrl,updatedAt:new Date().toISOString()});
 await updateViewIndex(env,id,{actualRating:rating});return {filmId:id,status:'saved',rating};
}
async function recordRatingObservation(env,observation){
 if(!await loadJSON(env,diagnosticSnapshotKey))return;
 const observations=await loadJSON(env,ratingObservationsKey)||[];
 if(!observations.some(o=>o.filmId===observation.filmId&&o.before===observation.before&&o.after===observation.after&&o.sourceUrl===observation.sourceUrl)){
  observations.push(observation);await saveJSON(env,ratingObservationsKey,observations);
 }
}
function parsePublicFilmsPage(html){
 const count=html.match(/title="([\d,]+)&nbsp;films"/i),total=count?Number(count[1].replaceAll(',','')):null;
 const entries=[];
 for(const item of html.matchAll(/<li\b[^>]*class="[^"]*\bgriditem\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)){
  const id=item[1].match(/data-postered-identifier='[^']*?&quot;lid&quot;:&quot;([a-zA-Z0-9_-]+)&quot;/),stars=item[1].match(/\brated-(10|[1-9])\b/);
  if(id)entries.push({id:id[1],rating:stars?Number(stars[1])/2:null});
 }
 const next=html.match(/<a\b[^>]*class="next"[^>]*href="(\/demo-user\/films\/page\/\d+\/)"/i)?.[1]||null;
 if(!Number.isInteger(total)||!entries.length)throw new Error('Incomplete Letterboxd films page');
 return {total,entries,next};
}
async function refreshRatingsFromFilms(env,report){
 let url='https://letterboxd.com/demo-user/films/',total=null,pages=0;const seen=new Map();
 while(url){
  let response;for(let attempt=0;attempt<3;attempt++){response=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (compatible; WatchlistAirtime/1.0)','Accept':'text/html','Accept-Language':'en-US,en;q=0.9'},signal:AbortSignal.timeout(15000)});if(response.status!==403||attempt===2)break;await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));}
  if(!response.ok){const body=await response.text(),challenge=/cloudflare|just a moment|attention required|captcha|bot detection/i.test(body);throw new Error('Letterboxd films HTTP '+response.status+' on page '+(pages+1)+(challenge?' (anti-bot challenge)':''));}
  const page=parsePublicFilmsPage(await response.text());pages++;
  if(pages>60||total!==null&&page.total!==total)throw new Error('Letterboxd films pagination changed');
  total=page.total;
  for(const item of page.entries){if(seen.has(item.id))throw new Error('Duplicate Letterboxd film');seen.set(item.id,item.rating);}
  url=page.next?'https://letterboxd.com'+page.next:null;
 }
 if(seen.size!==total)throw new Error('Incomplete Letterboxd films: '+seen.size+'/'+total);
 const index=await ensureInitialRatings(env),baseline=await loadJSON(env,diagnosticSnapshotKey);
 const watchlistIds=new Set((report.films||[]).map(f=>String(f.id))),ids=[...new Set([...watchlistIds,...(baseline?.films||[]).map(f=>f.filmId)])];let changed=0,rated=0;
 const observations=baseline?await loadJSON(env,ratingObservationsKey)||[]:null;
 for(const id of ids){const rating=seen.get(id)??null,inWatchlist=watchlistIds.has(id);if(rating!==null&&inWatchlist)rated++;if(!inWatchlist&&rating===null)continue;if(index[id]?.actualRating!==rating){
  const before=index[id]?.actualRating??null;
  if(observations&&!observations.some(o=>o.filmId===id&&o.programmeRunId===report.runId&&o.before===before&&o.after===rating))observations.push({filmId:id,before,after:rating,observedAt:new Date().toISOString(),source:'letterboxd_public_films',programmeRunId:report.runId});
  index[id]={...(index[id]||{}),actualRating:rating};changed++;
 }}
 if(observations&&changed)await saveJSON(env,ratingObservationsKey,observations);
 if(changed)await saveJSON(env,ENRICHMENT_KEY+'view-index.json',index);
 return {pages,watched:total,watchlistRated:rated,changed};
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
 const response=await fetch('https://letterboxd.com/demo-user/diary/',{headers:{'User-Agent':'Mozilla/5.0 (compatible; WatchlistAirtime/1.0)','Accept':'text/html','Accept-Language':'en-US,en;q=0.9'},signal:AbortSignal.timeout(15000)});
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
const nextCatchUpAt=()=>new Date(Math.floor(Date.now()/3600000+1)*3600000).toISOString();
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
function adaptivePredictionBatch(queue,capacity={},lastBatch=queue?.lastBatch){
 const hot=queue?.priorityCount||0,cold=queue?.coldRemaining??queue?.pending?.length??0,backlog=hot||cold;
 if(!backlog)return {batchSize:0,reason:'empty',usageKnown:Number.isFinite(capacity.remainingPercent)};
 const known=Number.isFinite(capacity.remainingPercent),remaining=known?Math.max(0,Math.min(100,capacity.remainingPercent)):null;
 if(remaining===0||capacity.quotaAvailable===false)return {batchSize:0,reason:'quota',usageKnown:known};
 let size=backlog<=4?backlog:backlog<=15?8:backlog<100?12:20;
 const usageCap=remaining===null?12:remaining<=10?4:remaining<=25?8:20;
 size=Math.min(size,usageCap);
 if(lastBatch?.stage==='partial'&&['quota','model_error','parse_error','storage_error'].includes(lastBatch.reason)&&!(known&&remaining>=50))size=Math.min(size,Math.max(4,Math.floor((lastBatch.batchSize||8)/2)));
 // Cold never consumes capacity while any hot prediction remains outstanding, including retry backoff.
 if(!hot)size=Math.min(size,5);
 return {batchSize:size,reason:known?'backlog_and_usage':'backlog_usage_unknown_conservative',usageKnown:known,remainingPercent:remaining,};
}
function safePredictionReason(value){
 const text=String(value||'');if(['external_termination','retry_backoff','format_error_storm','model_unavailable','api_error','lease_lost'].includes(text))return text;if(/quota|usage|limit/i.test(text))return 'quota';if(/time|deadline/i.test(text))return 'time_budget';if(/parse|json/i.test(text))return 'parse_error';if(/profile/i.test(text))return 'profile_changed';if(/lease|interrupt/i.test(text))return 'lease_expired';if(/storage|persist|checkpoint/i.test(text))return 'storage_error';if(/supersed|priority/i.test(text))return 'priority_changed';return text?'model_error':null;
}
const RUNNER_LEASE_KEY=ENRICHMENT_KEY+'runner-lease.json';
const RUNNER_LEASE_TTL=60*60000;
async function runnerLease(env,runId,operation='renew'){
 const object=await env.BUCKET.get(RUNNER_LEASE_KEY),old=object?await object.json():null,now=Date.now();
 if(operation==='acquire'&&old?.expiresAt>now)return {status:'already_running',runId:old.runId,expiresAt:old.expiresAt};
 if(operation!=='acquire'&&(!old||old.runId!==runId||old.expiresAt<=now))return {status:'lease_lost',runId:old?.runId||null};
 const value={owner:runId,runId,heartbeatAt:new Date(now).toISOString(),expiresAt:operation==='release'?0:now+RUNNER_LEASE_TTL};
 const saved=await env.BUCKET.put(RUNNER_LEASE_KEY,JSON.stringify(value),{onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});
 if(saved===null){const current=await loadJSON(env,RUNNER_LEASE_KEY);return {status:operation==='acquire'?'already_running':'lease_lost',runId:current?.runId||null};}
 return {status:'owned',...value};
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
 const at=new Date(now).toISOString();run.progressSavedCount=success;run.lastProgressAt=at;
 await writeEvent(env,{id:'enrichment-'+run.runId+(final?'':'-progress-'+success),type:'enrichment',at,stage:final?run.status:'running',runId:run.runId,trigger:run.trigger,added:summary.added,updated:summary.updated,failed:summary.failed,batchCount:summary.batchCount,remaining:run.hotRemaining+run.coldRemaining,hotRemaining:run.hotRemaining,coldRemaining:run.coldRemaining,queueSchemaVersion:4,reason:run.stopReason||null,nextCatchUpAt:nextCatchUpAt()});
 await savePredictionRun(env,run);
}
const STOP_EVENT_PREFIX=ENRICHMENT_KEY+'stop-events/';
function systemicReason(reason){
 const text=String(reason||'');if(['quota','model_unavailable','api_error','storage_error','lease_lost','format_error_storm','profile_changed','lease_expired','external_termination'].includes(text))return text;
 if(/quota|usage|limit/i.test(text))return 'quota';if(/lease/i.test(text))return 'lease_lost';if(/profile|model/i.test(text))return 'model_unavailable';return 'storage_error';
}
async function flushStopEvent(env,record,key){
 if(record.delivered)return true;
 for(let attempt=0;attempt<3;attempt++){try{await writeEvent(env,record.event);if(key){record.delivered=true;await saveJSON(env,key,record);}return true;}catch{}}
 return false;
}
async function recordRunStop(env,id,reason,fallback={}){
 let run=await checkedRun(env,id)||{runId:id,mode:'queued',trigger:fallback.trigger==='scheduled'?'scheduled':'manual',createdAt:new Date().toISOString(),selectedIds:[],results:{},failures:{}};
 const key=STOP_EVENT_PREFIX+id+'.json',existing=await loadJSON(env,key);let record=existing;
 if(!record){let queue=null;try{queue=await loadJSON(env,predictionQueueKey);}catch{}const summary=runSummary(run),at=run.event?.at||run.completedAt||new Date().toISOString();
 const event={remaining:queue?(queue.priorityCount||0)+(queue.coldRemaining||0):null,id:run.event?.id||'enrichment-'+id,type:'enrichment',runId:id,at,queueSchemaVersion:5,stage:'partial',title:'Прогнозы приостановлены',reason:systemicReason(reason),stopReason:systemicReason(reason),trigger:run.trigger,added:summary.added,updated:summary.updated,failed:summary.failed,checked:summary.checked,processed:summary.processed,hotProcessed:summary.hotProcessed,coldProcessed:summary.coldProcessed,batchCount:summary.batchCount,hotRemaining:queue?.priorityCount??fallback.hotRemaining??run.hotRemaining??null,coldRemaining:queue?.coldRemaining??fallback.coldRemaining??run.coldRemaining??null};
 record={event};const saved=await env.BUCKET.put(key,JSON.stringify(record),{onlyIf:{etagDoesNotMatch:'*'}});if(saved===null)record=await loadJSON(env,key);
 }
 run.status='partial';run.reason=record.event.reason;run.stopReason=record.event.reason;run.completedAt=record.event.at;run.event=record.event;run.counts={created:record.event.added,recalculated:record.event.updated,failed:record.event.failed,pending:(record.event.hotRemaining||0)+(record.event.coldRemaining||0)};
 await saveJSON(env,runKey(id),run);const latest=await loadJSON(env,ENRICHMENT_KEY+'latest-run.json');if(!latest||latest.runId===id||fallback.start)await saveJSON(env,ENRICHMENT_KEY+'latest-run.json',run);
 const written=await flushStopEvent(env,record,key);await runnerLease(env,id,'release');return {...record.event,status:'partial',mustComplete:true,eventPending:!written,counts:run.counts};
}
async function recoverStopEvents(env){
 let cursor;do{const page=await env.BUCKET.list({prefix:STOP_EVENT_PREFIX,limit:100,...(cursor?{cursor}:{})});for(const item of page.objects){const record=await loadJSON(env,item.key);if(record&&!record.delivered)await recordRunStop(env,record.event.runId,record.event.reason);}cursor=page.truncated?page.cursor:null;}while(cursor);
}
async function observedPrediction(env,body,work,stage){
 let response,data;try{response=await work();data=await response.clone().json();}catch(error){const id=body?.runId||'blocked-'+(body?.trigger==='scheduled'?'scheduled':'manual')+'-'+Math.floor(Date.now()/3600000);const stop=await recordRunStop(env,id,'storage_error',{start:stage==='start',trigger:body?.trigger});return json({...stop,error:'storage_error'},502);}
 const normal=['queue_empty','eligible_queue_empty','retry_backoff'];
 const stop=data.status==='lease_lost'?'lease_lost':data.mustComplete&&!normal.includes(data.stopReason)?data.stopReason:data.status==='blocked'&&data.reason!=='retry_backoff'?data.reason:response.status>=500?'storage_error':response.status===409&&data.error?.includes('Profile changed')?'profile_changed':stage==='start'&&response.status===409&&data.error?'model_unavailable':null;
 if(stop){const id=body?.runId||'blocked-'+(body?.trigger==='scheduled'?'scheduled':'manual')+'-'+Math.floor(Date.now()/3600000);const final=await recordRunStop(env,id,stop,{...data,start:stage==='start',trigger:body?.trigger});return json({...data,...final,stage:stage==='start'?'blocked':final.stage,status:stage==='start'?'blocked':data.status||'partial'},response.status);}
 return response;
}
async function predictionWriter(env,work){
 const object=await env.BUCKET.get(PREDICTION_MUTATION_LEASE),old=object?await object.json():null;
 if(old?.expiresAt>Date.now())return json({status:'busy',reason:'prediction_writer_busy',nextCatchUpAt:nextCatchUpAt()},409);
 const lease={id:crypto.randomUUID(),expiresAt:Date.now()+90000},saved=await env.BUCKET.put(PREDICTION_MUTATION_LEASE,JSON.stringify(lease),{onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});
 if(saved===null)return json({status:'busy',reason:'prediction_writer_busy',nextCatchUpAt:nextCatchUpAt()},409);
 try{return await work();}finally{const current=await env.BUCKET.get(PREDICTION_MUTATION_LEASE);if(current&&(await current.json()).id===lease.id)await env.BUCKET.put(PREDICTION_MUTATION_LEASE,JSON.stringify({...lease,expiresAt:0}),{onlyIf:{etagMatches:current.etag}});}
}
async function refreshPredictionQueue(env,report,trigger='reconcile'){
 const [profile,index,previous,catalog]=await Promise.all([loadJSON(env,profileKey),loadJSON(env,ENRICHMENT_KEY+'view-index.json'),loadJSON(env,predictionQueueKey),loadJSON(env,'epg/discovered-films.json')]);
 if(!profile||!report?.films)return null;
 const now=Date.now(),films=allEnrichmentFilms(report,catalog),watchlistIds=new Set(eligibleEnrichmentFilms(report).map(f=>String(f.id))),priority=Object.fromEntries(films.map(f=>[String(f.id),predictionPriority(f,now)])),missing=films.filter(f=>!indexedPredictionCurrent(index?.[String(f.id)],profile));
 missing.sort((a,b)=>{const x=priority[a.id],y=priority[b.id];return x.rank-y.rank||(x.rank===0?x.expiresInMs-y.expiresInMs:0)||Number(y.availableNow||y.availableToday)-Number(x.availableNow||x.availableToday)||Number(!!index?.[a.id]?.prediction)-Number(!!index?.[b.id]?.prediction)||(Date.parse(b.hotEnteredAt||b.discoveredAt)||0)-(Date.parse(a.hotEnteredAt||a.discoveredAt)||0)||String(a.id).localeCompare(String(b.id),'en');});
 const hotPending=missing.filter(f=>priority[f.id].hot).map(f=>String(f.id)),coldPending=missing.filter(f=>!priority[f.id].hot).map(f=>String(f.id)),pending=[...hotPending,...coldPending.filter(id=>watchlistIds.has(id))],currentIds=new Set(missing.map(f=>String(f.id))),retries=Object.fromEntries(Object.entries(previous?.retries||{}).filter(([id])=>currentIds.has(id)));
 const hotCount=films.filter(f=>priority[f.id].hot).length,hotPredicted=hotCount-hotPending.length,hotCatalogPredicted=films.filter(f=>priority[f.id].hot&&!watchlistIds.has(String(f.id))&&indexedPredictionCurrent(index?.[String(f.id)],profile)).length,addedHot=previous?.hotPending?hotPending.filter(id=>!previous.hotPending.includes(id)).length:0;
 const queue={schemaVersion:3,hotCount,coldCount:films.length-hotCount,coldWithoutPrediction:coldPending.filter(id=>!watchlistIds.has(id)).length,hotPredicted,profileVersion:profile.version,profileHash:profile.profileHash,programmeRunId:report.runId,refreshedAt:new Date().toISOString(),trigger,pending,hotPending,coldPending,priorityCount:hotPending.length,coldRemaining:coldPending.length,urgentCount:hotPending.filter(id=>priority[id].rank===0).length,priority:Object.fromEntries(missing.map(f=>[String(f.id),priority[f.id]])),retries,lastBatch:previous?.lastBatch||null,lastCheckAt:previous?.lastCheckAt||null,metrics:{hotAddedTotal:(previous?.metrics?.hotAddedTotal||0)+addedHot,hotProcessedTotal:previous?.metrics?.hotProcessedTotal||0},discovery:{ready:hotCatalogPredicted>=100,minimum:100,target:200,hotPredicted:hotCatalogPredicted,reason:hotCatalogPredicted>=100?'usable_hot_sample':'warming_hot_sample'}};
 await saveJSON(env,predictionQueueKey,queue);return queue;
}
async function queueStatus(env){const q=await loadJSON(env,predictionQueueKey);return q?{schemaVersion:q.schemaVersion,hotCount:q.hotCount,coldCount:q.coldCount,coldWithoutPrediction:q.coldWithoutPrediction,hotPredicted:q.hotPredicted,profileVersion:q.profileVersion,programmeRunId:q.programmeRunId,refreshedAt:q.refreshedAt,pendingCount:q.pending.length,priorityCount:q.priorityCount,hotRemaining:q.priorityCount,coldRemaining:q.coldRemaining??q.coldWithoutPrediction??0,urgentCount:q.urgentCount||0,adaptiveBatch:adaptivePredictionBatch(q),discovery:q.discovery||null,metrics:q.metrics||null,lastBatch:q.lastBatch,lastCheckAt:q.lastCheckAt,nextCatchUpAt:nextCatchUpAt()}:null;}
function queueReadyIds(queue){const ids=queue.priorityCount?queue.hotPending:queue.coldPending;return (ids||queue.pending||[]).filter(id=>!(queue.retries?.[id]?.retryAt>Date.now()));}
async function savePredictionRun(env,run){await saveJSON(env,runKey(run.runId),run);await saveJSON(env,ENRICHMENT_KEY+'latest-run.json',run);}
async function enrichmentStart(env,body,acquired=null){
 const mode=body.mode||'queued';if(!['watchlist_available','watchlist_all'].includes(body?.scope)||(body.limit!==undefined&&(!Number.isInteger(body.limit)||body.limit<1))||!['queued','legacy'].includes(mode)||(body.batchSize!==undefined&&(!Number.isInteger(body.batchSize)||body.batchSize<1||body.batchSize>MAX_PREDICTION_BATCH)))return json({error:'Invalid scope, mode or batchSize'},400);
 if(body.capacity!==undefined&&(!isObject(body.capacity)||body.capacity.remainingPercent!==undefined&&(!Number.isFinite(body.capacity.remainingPercent)||body.capacity.remainingPercent<0||body.capacity.remainingPercent>100)))return json({error:'Invalid capacity'},400);
 const [profile,report,sync]=await Promise.all([loadJSON(env,profileKey),loadJSON(env,'programme.json'),loadJSON(env,'sync.json')]);if(!profile)return json({error:'Taste profile is not configured'},409);if(!report?.runId||!report?.films||!sync||sync.stage!=='complete'&&sync.runId===report.runId)return json({error:'No completed programme snapshot'},409);
 const catalog=mode==='queued'?await loadJSON(env,'epg/discovered-films.json'):null,eligible=mode==='queued'?allEnrichmentFilms(report,catalog):eligibleEnrichmentFilms(report),queue=mode==='queued'?await refreshPredictionQueue(env,report,body.trigger==='scheduled'?'scheduled':'manual'):null,plan=mode==='queued'?adaptivePredictionBatch(queue,body.capacity):null;
 // Explicit small nonlegacy diagnostics batches remain possible. The old scheduled 4 is a legacy hint, not a throughput cap.
 const batchSize=mode==='queued'?Math.min(plan.batchSize,body.batchSize!==undefined&&!(body.trigger==='scheduled'&&body.batchSize===4)?body.batchSize:MAX_PREDICTION_BATCH):eligible.length;
 const previous=await loadJSON(env,ENRICHMENT_KEY+'latest-run.json');
 const runId=acquired?.runId||crypto.randomUUID(),lease=acquired||await runnerLease(env,runId,'acquire');if(lease.status!=='owned')return json({...lease,runner:predictionRunnerContract()});
 if(previous?.status==='running')await recordRunStop(env,previous.runId,'lease_expired');
 const selected=mode==='queued'?queueReadyIds(queue).slice(0,batchSize).map(id=>eligible.find(f=>String(f.id)===id)).filter(Boolean):body.limit===undefined?eligible:eligible.slice(0,body.limit);
 if(mode==='queued'&&!selected.length){await runnerLease(env,runId,'release');const at=new Date().toISOString(),remaining=queue.priorityCount+queue.coldRemaining,reason=plan.reason==='quota'?'quota':remaining?'retry_backoff':null,stage=reason?'blocked':'noop';queue.lastCheckAt=at;queue.lastBatch={runId:null,trigger:body.trigger==='scheduled'?'scheduled':'manual',startedAt:at,finishedAt:at,stage,profileVersion:profile.version,batchSize:0,hotProcessed:0,coldProcessed:0,hotRemaining:queue.priorityCount,coldRemaining:queue.coldRemaining,checked:0,added:0,updated:0,failed:0,remaining,reason};await saveJSON(env,predictionQueueKey,queue);if(reason==='retry_backoff')await writeEvent(env,{id:'enrichment-blocked-'+Math.floor(Date.now()/3600000),type:'enrichment',at,queueSchemaVersion:3,...queue.lastBatch,nextCatchUpAt:nextCatchUpAt()});return json({status:stage,...queue.lastBatch,nextCatchUpAt:nextCatchUpAt()});}
 const states=await Promise.all(selected.map(f=>readFilmState(env,f.id))),baseline=Object.fromEntries(selected.map((f,i)=>[String(f.id),states[i].predictions?.current?.generatedAt||null])),pendingCount=mode==='queued'?queue.pending.length:states.filter(s=>!predictionCurrent(s.predictions?.current,profile,s.fingerprint)).length;
 if(mode!=='queued'&&previous?.status==='running'&&previous.sourceProgrammeRunId===report.runId&&previous.tasteProfileHash===profile.profileHash&&previous.selectedIds?.join('|')===selected.map(f=>String(f.id)).join('|'))return json({...runSummary(previous),pendingCount});
 const createdAt=new Date().toISOString(),run={runId,pipelineVersion:PREDICTION_PIPELINE_VERSION,status:'running',mode,trigger:body.trigger==='scheduled'?'scheduled':'manual',createdAt,lastActivityAt:createdAt,deadlineAt:null,lastHeartbeatAt:createdAt,batchCount:1,capacity:body.capacity||{},sourceProgrammeRunId:report.runId,tasteProfileVersion:profile.version,tasteProfileHash:profile.profileHash,fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,predictionPromptVersion:PREDICTION_PROMPT_VERSION,eligibleCount:eligible.length,batchSize:selected.length,adaptivePlan:plan,selectedIds:selected.map(f=>String(f.id)),selectionKind:Object.fromEntries(selected.map(f=>[String(f.id),mode==='queued'&&queue.priority[f.id]?.hot?'hot':'cold'])),baseline,failures:{},results:{}};
 await saveJSON(env,ENRICHMENT_KEY+'sources/'+run.runId+'.json',Object.fromEntries(selected.map(f=>[String(f.id),modelMetadata(f)])));await savePredictionRun(env,run);return json({...runSummary(run),pendingCount,hotRemaining:queue?.priorityCount??null,coldRemaining:queue?.coldRemaining??null,nextCatchUpAt:nextCatchUpAt(),runner:predictionRunnerContract()});
}
function predictionRunnerContract(){return {pipelineVersion:5,continuous:true,itemFailures:{reportVia:'submit items[].failure.kind',allowedKinds:['parse_error','validation_error'],retryable:true,retryBaseMs:3600000,stopAfterConsecutive:5},maxBatchFilms:20,maxRunFilms:null,maxRunMinutes:null,leaseTtlMs:RUNNER_LEASE_TTL,heartbeat:'/api/enrichment/heartbeat',read:'/api/enrichment/runner',modelBatching:{enabled:false,readyFingerprintsPerCall:1},instructions:['Start returns already_running: exit immediately, do not adopt its runId.','Repeat next/submit continuously across adaptive batches until queue empty or real quota/API/storage failure. No time or total-film cap.','Keep profile and scoring rules unchanged; reuse valid fingerprints and predictions. Submit each film immediately.','Heartbeat before model calls and after checkpoints; for a call lasting more than 10 minutes renew concurrently.','Malformed/invalid per-film outputs: submit {filmId,failure:{kind:parse_error}} as valid JSON, then continue next/submit. Never complete for one item parse_error.','Stop only on mustComplete/systemic quota/API/storage/lease failure; complete with stopReason. Five consecutive distinct item format failures trigger format_error_storm.']};}
function runSummary(r){return {runId:r.runId,processed:Object.values(r.results||{}).filter(x=>x!=='failed').length,batchCount:r.batchCount||1,lastHeartbeatAt:r.lastHeartbeatAt||null,hotRemaining:r.hotRemaining??null,coldRemaining:r.coldRemaining??null,stopReason:r.stopReason||null,sourceProgrammeRunId:r.sourceProgrammeRunId,tasteProfileVersion:r.tasteProfileVersion,tasteProfileHash:r.tasteProfileHash,fingerprintSchemaVersion:r.fingerprintSchemaVersion,predictionPromptVersion:r.predictionPromptVersion,eligibleCount:r.eligibleCount,selectedCount:r.selectedIds.length,batchSize:r.batchSize??r.selectedIds.length,adaptivePlan:r.adaptivePlan||null,deadlineAt:r.deadlineAt||null,status:r.status,trigger:r.trigger||'manual',startedAt:r.createdAt,finishedAt:r.completedAt||null,checked:Object.keys(r.results||{}).length,added:Object.values(r.results||{}).filter(x=>x==='created').length,updated:Object.values(r.results||{}).filter(x=>x==='recalculated').length,failed:Object.keys(r.failures||{}).length,hotProcessed:Object.entries(r.results||{}).filter(([id,status])=>['created','recalculated'].includes(status)&&r.selectionKind?.[id]==='hot').length,coldProcessed:Object.entries(r.results||{}).filter(([id,status])=>['created','recalculated'].includes(status)&&r.selectionKind?.[id]==='cold').length};}
async function checkedRun(env,id){if(!isText(id,100))return null;return loadJSON(env,runKey(id));}
async function enrichmentNext(env,body){
 const run=await checkedRun(env,body?.runId);if(!run)return json({error:'Unknown run'},404);if(run.status!=='running')return json({error:'Run already complete',stopReason:run.stopReason||null,mustComplete:!!run.reason},409);const requestSize=body.batchSize??run.batchSize??MAX_PREDICTION_BATCH;if(!Number.isInteger(requestSize)||requestSize<1||requestSize>20)return json({error:'Invalid batchSize'},400);
 const lease=await runnerLease(env,run.runId);if(lease.status!=='owned')return json(lease,409);run.lastHeartbeatAt=lease.heartbeatAt;
 if(run.systemicStopReason)return json({runId:run.runId,items:[],mustComplete:true,stopReason:run.systemicStopReason});
 if(body.capacity?.remainingPercent===0||body.capacity?.quotaAvailable===false)return json({runId:run.runId,items:[],mustComplete:true,stopReason:'quota'});
 const profile=await loadJSON(env,profileKey);if(profile?.profileHash!==run.tasteProfileHash)return json({error:'Profile changed; start a new run'},409);
 let source=await loadJSON(env,ENRICHMENT_KEY+'sources/'+run.runId+'.json')||{},states=await Promise.all(run.selectedIds.map(id=>readFilmState(env,id))),index=await loadJSON(env,ENRICHMENT_KEY+'view-index.json')||{},repair=false,runRepair=false;
 for(let i=0;i<run.selectedIds.length;i++){const id=run.selectedIds[i],s=states[i],p=s.predictions?.current;if(predictionCurrent(p,profile,s.fingerprint)&&index[id]?.prediction?.generatedAt!==p.generatedAt){index[id]={...(index[id]||{}),prediction:p,fingerprintHash:s.fingerprint.fingerprintHash,fingerprint:fingerprintFacet(s.fingerprint)};repair=true;}}
 for(let i=0;i<run.selectedIds.length;i++){const id=run.selectedIds[i],s=states[i],p=s.predictions?.current;if(run.failures[id]&&predictionCurrent(p,profile,s.fingerprint)){delete run.failures[id];run.results[id]=p.generatedAt!==run.baseline[id]?(run.baseline[id]?'recalculated':'created'):'already_current';runRepair=true;}}
 if(repair)await saveJSON(env,ENRICHMENT_KEY+'view-index.json',index);if(runRepair)await savePredictionRun(env,run);
 if(run.mode==='queued'){
  const report=await loadJSON(env,'programme.json'),queue=await refreshPredictionQueue(env,report,'next_priority'),catalog=await loadJSON(env,'epg/discovered-films.json'),films=new Map(allEnrichmentFilms(report,catalog).map(f=>[String(f.id),f])),completed=run.selectedIds.filter((id,i)=>predictionCurrent(states[i].predictions?.current,profile,states[i].fingerprint)||run.results?.[id]);
  let slots=Math.max(0,run.batchSize-completed.filter(id=>(run.batchIds||run.selectedIds).includes(id)).length),newBatch=false;
  if(!slots){const plan=adaptivePredictionBatch(queue,body.capacity||run.capacity);run.adaptivePlan=plan;run.batchSize=plan.batchSize;slots=plan.batchSize;run.batchIds=[];newBatch=true;}
  const ready=queueReadyIds(queue).filter(id=>!run.failures[id]).slice(0,slots);run.batchIds=[...new Set([...(run.batchIds||completed),...ready])];const selected=[...new Set([...(newBatch?[]:completed),...ready])];if(newBatch&&ready.length)run.batchCount++;
  run.hotRemaining=queue.priorityCount;run.coldRemaining=queue.coldRemaining;await runnerProgress(env,run,queue);await savePredictionRun(env,run);
  if(!ready.length){const reason=run.adaptivePlan?.reason==='quota'?'quota':queue.priorityCount+queue.coldRemaining?'eligible_queue_empty':'queue_empty';return json({runId:run.runId,items:[],mustComplete:true,stopReason:reason,hotRemaining:queue.priorityCount,coldRemaining:queue.coldRemaining});}
  if(selected.join('|')!==run.selectedIds.join('|')){
   run.selectedIds=selected;for(const id of ready){if(!source[id]){const film=films.get(id);if(!film)continue;source[id]=modelMetadata(film);const s=await readFilmState(env,id);run.baseline[id]=s.predictions?.current?.generatedAt||null;}run.selectionKind[id]=queue.priority[id]?.hot?'hot':'cold';}
   await saveJSON(env,ENRICHMENT_KEY+'sources/'+run.runId+'.json',source);await savePredictionRun(env,run);states=await Promise.all(selected.map(id=>readFilmState(env,id)));
  }
 }
 const items=[];let pendingCount=0;
 for(let i=0;i<run.selectedIds.length;i++){const id=run.selectedIds[i],s=states[i];if(predictionCurrent(s.predictions?.current,profile,s.fingerprint)||run.failures[id])continue;pendingCount++;if(items.length>=requestSize)continue;const film=source[id];if(!film)continue;const requiredWork=fingerprintCurrent(s.fingerprint)?'prediction_only':'fingerprint_and_prediction',item={filmId:id,requiredWork};if(requiredWork==='prediction_only')item.fingerprint=s.fingerprint;else item.metadata=film;items.push(item);}
 return json({runId:run.runId,profile:profile.profile,profileVersion:profile.version,profileHash:profile.profileHash,fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,predictionPromptVersion:PREDICTION_PROMPT_VERSION,items,pendingCount,batchSize:run.batchSize,deadlineAt:run.deadlineAt||null,modelBatching:predictionRunnerContract().modelBatching});
}
async function enrichmentSubmit(env,body){
 const run=await checkedRun(env,body?.runId);if(!run)return json({error:'Unknown run'},404);if(run.status!=='running')return json({error:'Run already complete',stopReason:run.stopReason||null,mustComplete:!!run.reason},409);if(!Array.isArray(body.items)||!body.items.length||body.items.length>10)return json({error:'Expected 1–10 items'},400);
 const lease=await runnerLease(env,run.runId);if(lease.status!=='owned')return json(lease,409);run.lastHeartbeatAt=lease.heartbeatAt;
 if(run.systemicStopReason)return json({...runSummary(run),mustComplete:true,stopReason:run.systemicStopReason});
 const profile=await loadJSON(env,profileKey);if(profile?.profileHash!==run.tasteProfileHash)return json({error:'Profile changed; start a new run'},409);
 const results=[];
 for(const item of body.items){const id=String(item?.filmId||'');if(!run.selectedIds.includes(id)){results.push({filmId:id,error:'Film not selected',failureScope:'request'});continue;}
  // Re-delivering the same failed outcome is idempotent and cannot manufacture an error storm.
  if(run.failures[id]?.scope==='item'){results.push({filmId:id,status:'retryable_failure',error:run.failures[id].kind,failureScope:'item',retryable:true,retryAt:run.failures[id].retryAt});continue;}
  let failureStage='storage_error';try{const state=await readFilmState(env,id);let fingerprint=state.fingerprint;
   if(item.failure&&!predictionCurrent(state.predictions?.current,profile,fingerprint)){failureStage='parse_error';throw new Error('Reported malformed model response');}
   if(item.fingerprint&&!fingerprintCurrent(fingerprint)){const issue=validateFingerprint(item.fingerprint);if(issue){failureStage='parse_error';throw new Error(issue);}const value={...item.fingerprint,filmId:id,generatedAt:new Date().toISOString(),invalidatedAt:null};value.fingerprintHash=await contentHash({...item.fingerprint,filmId:id});await saveJSON(env,filmKey(id)+'fingerprint.json',value);fingerprint=value;await updateViewIndex(env,id,{fingerprintHash:value.fingerprintHash,fingerprint:fingerprintFacet(value)});}
   if(!fingerprintCurrent(fingerprint)){failureStage='parse_error';throw new Error('Current fingerprint required');}
   if(predictionCurrent(state.predictions?.current,profile,fingerprint)){await updateViewIndex(env,id,{prediction:state.predictions.current,fingerprintHash:fingerprint.fingerprintHash,fingerprint:fingerprintFacet(fingerprint)});run.results[id] ||= 'already_current';delete run.failures[id];results.push({filmId:id,status:'already_current'});}
   else{const issue=validatePrediction(item.prediction);if(issue){failureStage='parse_error';throw new Error(issue);}const at=new Date().toISOString(),prediction={...item.prediction,filmId:id,generatedAt:at,tasteProfileVersion:profile.version,tasteProfileHash:profile.profileHash,fingerprintHash:fingerprint.fingerprintHash,fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,predictionPromptVersion:PREDICTION_PROMPT_VERSION},old=state.predictions?.current,history=[...(state.predictions?.history||[])];if(old)history.push({...old,replacedAt:at});await saveJSON(env,filmKey(id)+'predictions.json',{current:prediction,history});await updateViewIndex(env,id,{prediction,fingerprintHash:fingerprint.fingerprintHash,fingerprint:fingerprintFacet(fingerprint)});delete run.failures[id];run.results[id]=old?'recalculated':'created';results.push({filmId:id,status:run.results[id]});}
   run.formatFailureStreak=0;
  }catch(e){const at=new Date().toISOString(),retryable=failureStage==='parse_error',previous=await loadJSON(env,predictionQueueKey),attempts=(previous?.retries?.[id]?.attempts||0)+1,retryAt=Date.now()+Math.min(6*3600000,3600000*2**(attempts-1));
   run.failures[id]={kind:failureStage,scope:retryable?'item':'run',retryable:true,failedAt:at,retryAt,attempts};run.results[id]='failed';results.push({filmId:id,status:retryable?'retryable_failure':'failed',error:failureStage,failureScope:retryable?'item':'run',retryable:true,retryAt});
   if(retryable){run.formatFailureStreak=(run.formatFailureStreak||0)+1;if(run.formatFailureStreak>=5)run.systemicStopReason='format_error_storm';}else run.systemicStopReason=failureStage;
  }
  run.lastActivityAt=new Date().toISOString();const renewed=await runnerLease(env,run.runId);if(renewed.status!=='owned')return json(renewed,409);run.lastHeartbeatAt=renewed.heartbeatAt;await savePredictionRun(env,run);
  // Retry state is persisted immediately, not postponed until the eventual run completion.
  if(run.failures[id]){const queue=await loadJSON(env,predictionQueueKey);if(queue){queue.retries||={};queue.retries[id]={...run.failures[id],lastRunId:run.runId};await saveJSON(env,predictionQueueKey,queue);}}
  if(run.systemicStopReason)break;
 }
 let queue=null;if(run.mode==='queued')queue=await refreshPredictionQueue(env,await loadJSON(env,'programme.json'),'batch_progress');await runnerProgress(env,run,queue);
 return json({...runSummary(run),results,mustComplete:!!run.systemicStopReason,stopReason:run.systemicStopReason||null,remaining:queue?.pending.length??null,hotRemaining:queue?.priorityCount??null,coldRemaining:queue?.coldRemaining??null,nextCatchUpAt:nextCatchUpAt()});
}
async function enrichmentComplete(env,body){
 const run=await checkedRun(env,body?.runId);if(!run)return json({error:'Unknown run'},404);
 if(run.status==='complete'||run.status==='partial'){if(run.event)await writeEvent(env,run.event);else await writeEvent(env,{id:'enrichment-'+run.runId,type:'enrichment',at:run.completedAt,...run.counts});await runnerLease(env,run.runId,'release');return json({runId:run.runId,status:run.status,counts:run.counts,...(run.event||{})});}
 const lease=await runnerLease(env,run.runId);if(lease.status!=='owned')return json(lease,409);run.lastHeartbeatAt=lease.heartbeatAt;
 if(body.reason&&!['queue_empty','eligible_queue_empty','parse_error','retry_backoff'].includes(body.reason))return json(await recordRunStop(env,run.runId,systemicReason(body.reason)));
 const profile=await loadJSON(env,profileKey);if(profile?.profileHash!==run.tasteProfileHash&&!body.reason)return json({error:'Profile changed; start a new run'},409);
 if(run.mode==='queued'&&(!body.reason||['queue_empty','eligible_queue_empty','parse_error'].includes(body.reason))&&!run.systemicStopReason){const queue=await refreshPredictionQueue(env,await loadJSON(env,'programme.json'),'completion_check');if(queueReadyIds(queue).some(id=>!run.failures[id]))return json({error:'Queue not empty; continue next',runId:run.runId,hotRemaining:queue.priorityCount,coldRemaining:queue.coldRemaining},409);}
 const states=await Promise.all(run.selectedIds.map(id=>readFilmState(env,id)));let created=0,recalculated=0,pending=0;
 for(let i=0;i<states.length;i++){const s=states[i],p=s.predictions?.current,id=run.selectedIds[i];if(p?.generatedAt&&p.generatedAt!==run.baseline[id]&&p.tasteProfileHash===run.tasteProfileHash&&p.predictionPromptVersion===run.predictionPromptVersion){run.baseline[id]?recalculated++:created++;if(!['created','recalculated'].includes(run.results?.[id]))run.results[id]=run.baseline[id]?'recalculated':'created';}else if(!run.failures[id]&&!predictionCurrent(p,profile,s.fingerprint))pending++;}
 created=Object.values(run.results).filter(x=>x==='created').length;recalculated=Object.values(run.results).filter(x=>x==='recalculated').length;const failed=Object.keys(run.failures).length;run.counts={created,recalculated,failed,pending};run.reason=['queue_empty','eligible_queue_empty','parse_error'].includes(body.reason)?null:safePredictionReason(body.reason||run.interruption);run.reason=run.systemicStopReason||run.reason;run.stopReason=run.reason||(failed?'eligible_queue_empty':pending?'external_termination':'queue_empty');run.status=pending||run.reason?'partial':'complete';run.completedAt=new Date().toISOString();
 const summary=runSummary(run);let hotRemaining=null,coldRemaining=null,remaining=pending;
 if(run.mode==='queued'){
  const queue=await refreshPredictionQueue(env,await loadJSON(env,'programme.json'),'batch_complete');remaining=queue?.pending.length??pending;hotRemaining=queue?.priorityCount??null;coldRemaining=queue?.coldRemaining??null;
  if(queue){for(const id of Object.keys(run.failures)){if(queue.retries[id]?.lastRunId===run.runId)continue;const failure=run.failures[id],tries=(queue.retries[id]?.attempts||0)+1;queue.retries[id]={attempts:tries,retryAt:failure.retryAt||Date.now()+Math.min(6*3600000,3600000*2**(tries-1)),retryable:true,scope:failure.scope||'run',kind:failure.kind||failure,lastRunId:run.runId};}
   queue.lastBatch={runId:run.runId,trigger:run.trigger,startedAt:run.createdAt,finishedAt:run.completedAt,stage:run.status,profileVersion:run.tasteProfileVersion,batchSize:run.batchSize,hotProcessed:summary.hotProcessed,coldProcessed:summary.coldProcessed,checked:summary.checked,added:created,updated:recalculated,failed,remaining,hotRemaining,coldRemaining,reason:run.reason,perFilmMs:created+recalculated?(Date.parse(run.completedAt)-Date.parse(run.createdAt))/(created+recalculated):null};queue.lastCheckAt=run.completedAt;queue.metrics.hotProcessedTotal+=summary.hotProcessed;await saveJSON(env,predictionQueueKey,queue);}
 }
 const event={id:'enrichment-'+run.runId,type:'enrichment',at:run.completedAt,...run.counts,checked:summary.checked,added:created,updated:recalculated,batchSize:run.batchSize,hotProcessed:summary.hotProcessed,coldProcessed:summary.coldProcessed,remaining,hotRemaining,coldRemaining,queueSchemaVersion:4,batchCount:run.batchCount,lastHeartbeatAt:run.lastHeartbeatAt,stopReason:run.stopReason,trigger:run.trigger,stage:run.status,reason:run.reason,nextCatchUpAt:nextCatchUpAt()};run.event=event;await savePredictionRun(env,run);await writeEvent(env,event);await runnerLease(env,run.runId,'release');return json({runId:run.runId,status:run.status,counts:run.counts,...event});
}
async function enrichmentStatus(env){const [profile,run,report,queue,catalog,discovery]=await Promise.all([loadJSON(env,profileKey),loadJSON(env,ENRICHMENT_KEY+'latest-run.json'),loadJSON(env,'programme.json'),queueStatus(env),loadJSON(env,'epg/discovered-films.json'),loadJSON(env,'epg/discovery-status.json')]);const films=report?allEnrichmentFilms(report,catalog):[];return {profileVersion:profile?.version||null,fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,predictionPromptVersion:PREDICTION_PROMPT_VERSION,lastRun:run?{...runSummary(run),counts:run.counts||null,failures:run.failures,reason:run.reason||null,completedAt:run.completedAt||null}:null,selectedCount:films.length,pendingCount:queue?.pendingCount??null,discovery:discovery||null,queue};}
async function enrichmentView(env){const [profile,index]=await Promise.all([loadJSON(env,profileKey),ensureInitialRatings(env)]);return {moodVocabulary:{version:MOOD_MAPPING_VERSION,labels:MOOD_LABELS},profile:profile?{version:profile.version,updatedAt:profile.updatedAt}:null,films:Object.fromEntries(Object.entries(index||{}).map(([id,item])=>{const p=item.prediction,f=item.fingerprint,facet=canonicalMoodFacet(f,p);return [id,{moodIds:facet.moodIds,fingerprint:f&&f.fingerprintHash===item.fingerprintHash?{plotMechanics:f.plotMechanics||[],moodIds:facet.moodIds}:null,prediction:p?{predictedRating:p.predictedRating,probability4Plus:p.probability4Plus,confidence:p.confidence,matchSignals:p.matchSignals,mainRisk:p.mainRisk,moodIds:facet.moodIds,stale:!profile||p.tasteProfileVersion!==profile.version||p.tasteProfileHash!==profile.profileHash||p.fingerprintHash!==item.fingerprintHash||p.predictionPromptVersion!==PREDICTION_PROMPT_VERSION||p.fingerprintSchemaVersion!==FINGERPRINT_SCHEMA_VERSION}:null,actualRating:item.actualRating??null}];}))};}

async function backfillFingerprintView(env,body){const [index,report,catalog]=await Promise.all([ensureInitialRatings(env),loadJSON(env,'programme.json'),loadJSON(env,'epg/discovered-films.json')]),ids=[...new Set([...Object.keys(index),...allEnrichmentFilms(report||{films:[]},catalog).map(f=>String(f.id))])].sort(),cursor=String(body.cursor||'');if(body.limit!==undefined&&(!Number.isInteger(body.limit)||body.limit<1||body.limit>100))return json({error:'Invalid limit'},400);const selected=ids.filter(id=>id>cursor).slice(0,body.limit||80),fingerprints=await Promise.all(selected.map(id=>loadJSON(env,filmKey(id)+'fingerprint.json')));let added=0,updated=0;for(let i=0;i<selected.length;i++){const id=selected[i],facet=fingerprintFacet(fingerprints[i]);if(!facet||index[id]?.fingerprint?.fingerprintHash===facet.fingerprintHash)continue;const existed=!!index[id]?.fingerprint;index[id]={...(index[id]||{}),fingerprintHash:facet.fingerprintHash,fingerprint:facet};existed?updated++:added++;}if(added||updated)await saveJSON(env,ENRICHMENT_KEY+'view-index.json',index);return json({checked:selected.length,added,updated,nextCursor:selected.length&&ids.some(id=>id>selected.at(-1))?selected.at(-1):null});}
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
async function enrichmentRoute(request,env,url,execution){const path=url.pathname;let body=null;if(['POST','PUT'].includes(request.method)){try{body=await request.json();}catch{return json({error:'Invalid JSON'},400);}if(!isObject(body))return json({error:'Invalid request'},400);}
 if(path==='/api/enrichment/discovery/reconcile'&&request.method==='POST'){
  let [source,decisions]=await Promise.all([loadJSON(env,'epg/discovery-latest.json'),loadJSON(env,'epg/discovery-resolution.json')]);if(!source?.items)return json({error:'No discovery catalog'},409);
  if(source.canonicalizedAt&&source.canonicalizedAt!==decisions?.__canonicalizedAt){[source,decisions]=await Promise.all([loadJSON(env,'epg/discovery-before-canonical.json'),loadJSON(env,'epg/discovery-resolution-before-canonical.json')]);if(!source?.items)return json({error:'Canonicalization backup missing'},409);}
  let result;try{result=canonicalizeDiscoveryLedger(source,decisions||{});}catch(e){return json({error:String(e.message).slice(0,160)},409);}
  const changed=result.duplicatesRemoved>0||result.items.some((item,i)=>item.key!==source.items[i]?.key);
  if(changed){await saveJSON(env,'epg/discovery-before-canonical.json',source);await saveJSON(env,'epg/discovery-resolution-before-canonical.json',decisions||{});
   const at=new Date().toISOString();await saveJSON(env,'epg/discovery-latest.json',{...source,items:result.items,canonicalizedAt:at});await saveJSON(env,'epg/discovery-resolution.json',{...result.decisions,__canonicalizedAt:at});}
  return json({changed,before:source.items.length,after:result.items.length,duplicatesRemoved:result.duplicatesRemoved,carriedVerified:result.carriedVerified,retried:result.retried});
 }
 if(path==='/api/enrichment/discovery/resolve'&&request.method==='POST'){
  if(body.limit!==undefined&&(!Number.isInteger(body.limit)||body.limit<1||body.limit>24))return json({error:'Invalid limit'},400);
  const report=await loadJSON(env,'programme.json');if(!report?.films)return json({error:'No programme'},409);
  const result=await resolveDiscoveryBatch(env,report,body.limit||24);result.continuation=await continueDiscovery(request,env,execution,result,body);return json(result);
 }
 if(path==='/api/enrichment/discovery/scan'&&request.method==='POST'){
  const report=await loadJSON(env,'programme.json');if(!report?.films)return json({error:'No programme'},409);
  const now=Date.now(),response=await fetch('https://example.invalid/epg.xml',{signal:AbortSignal.timeout(110000)});if(!response.ok)return json({error:'EPG HTTP '+response.status},502);
  const cache=await loadJSON(env,'epg/discovered-films.json')||{},known=new Set(report.films.map(f=>String(f.tmdbId)));const result=await scanEPG(response.body,[...report.films,...Object.values(cache).filter(f=>!known.has(String(f.tmdbId))).map(f=>({...f,catalogOnly:true}))],now);if(result.stats.epgEnd<now+8*3600000)return json({error:'EPG horizon too short'},502);
  const old=await loadJSON(env,'epg/discovery-latest.json'),items=mergeDiscoveryCandidates(old?.items,result.discovery);await saveJSON(env,'epg/discovery-latest.json',{programmeRunId:report.runId,updatedAt:new Date(now).toISOString(),rawCandidates:result.stats.rawCandidates,filteredNonMovies:result.stats.filteredNonMovies,items});await refreshPredictionQueue(env,report,'epg_scan');await continueDiscovery(request,env,execution,{remaining:1,stage:'ready'},body);return json({programmeRunId:report.runId,candidates:items.length,newCandidates:items.length-(old?.items?.length||0),scanned:result.stats.scanned});
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
 if(path==='/api/enrichment/diagnostics/snapshot'&&request.method==='GET'){const snapshot=await loadJSON(env,diagnosticSnapshotKey);return snapshot?json(snapshot):json({error:'No frozen diagnostic snapshot'},404);}
 if(path==='/api/enrichment/diagnostics/accuracy'&&request.method==='GET'){const snapshot=await loadJSON(env,diagnosticSnapshotKey);return snapshot?json(prospectiveAccuracy(snapshot,await loadJSON(env,ratingObservationsKey)||[])):json({error:'No frozen diagnostic snapshot'},404);}
 if(path==='/api/enrichment/profile'&&request.method==='GET'){const p=await loadJSON(env,profileKey);return p?json(p):json({error:'Taste profile is not configured'},404);}
 if(path==='/api/enrichment/profile'&&request.method==='PUT'){if(body.schemaVersion!==1||!Number.isInteger(body.version)||body.version<1)return json({error:'Invalid version or schemaVersion'},400);const issue=validateProfile(body.profile);if(issue)return json({error:issue},400);const current=await loadJSON(env,profileKey);if(current&&body.version<=current.version)return json({error:'Version must increase'},409);const value={version:body.version,schemaVersion:1,updatedAt:new Date().toISOString(),profileHash:await contentHash(body.profile),profile:body.profile};await saveJSON(env,ENRICHMENT_KEY+'profile/versions/'+body.version+'.json',value);await saveJSON(env,profileKey,value);try{await refreshPredictionQueue(env,await loadJSON(env,'programme.json'),'profile_updated');}catch{}return json(value);}
 if(path==='/api/enrichment/benchmark/start'&&request.method==='POST')return predictionWriter(env,()=>predictionBenchmarkStart(env));
 if(path==='/api/enrichment/benchmark/trial'&&request.method==='POST')return predictionWriter(env,()=>predictionBenchmarkTrial(env,body));
 if(path==='/api/enrichment/runner'&&request.method==='GET')return json(predictionRunnerContract());
 if(path==='/api/enrichment/heartbeat'&&request.method==='POST')return observedPrediction(env,body,()=>predictionWriter(env,()=>runnerHeartbeat(env,body)),'heartbeat');
 if(path==='/api/enrichment/start'&&request.method==='POST')return observedPrediction(env,body,async()=>{
  const runId=crypto.randomUUID(),lease=await runnerLease(env,runId,'acquire');if(lease.status!=='owned')return json(lease);
  try{const response=await predictionWriter(env,()=>enrichmentStart(env,body,lease));if(response.status>=400)await runnerLease(env,runId,'release');return response;}catch(error){await runnerLease(env,runId,'release');throw error;}
 },'start');
 if(path==='/api/enrichment/queue/reconcile'&&request.method==='POST'){const report=await loadJSON(env,'programme.json');const queue=await refreshPredictionQueue(env,report,'manual_reconcile');return queue?json(await queueStatus(env)):json({error:'Programme or taste profile unavailable'},409);}
 if(path==='/api/enrichment/queue/status'&&request.method==='GET')return json(await queueStatus(env)||{status:'not_initialized',pendingCount:null,nextCatchUpAt:nextCatchUpAt()});
 if(path==='/api/enrichment/next'&&request.method==='POST')return observedPrediction(env,body,()=>predictionWriter(env,()=>enrichmentNext(env,body)),'next');
 if(path==='/api/enrichment/submit'&&request.method==='POST')return observedPrediction(env,body,()=>predictionWriter(env,()=>enrichmentSubmit(env,body)),'submit');
 if(path==='/api/enrichment/complete'&&request.method==='POST')return observedPrediction(env,body,()=>predictionWriter(env,()=>enrichmentComplete(env,body)),'complete');
 if(path==='/api/enrichment/status'&&request.method==='GET'){await recoverStopEvents(env);return json(await enrichmentStatus(env));}
 if(path==='/api/enrichment/moods/diagnostics'&&request.method==='GET')return json(moodDiagnostics(await loadJSON(env,ENRICHMENT_KEY+'view-index.json')));
 if(path==='/api/enrichment/moods/backfill'&&request.method==='POST')return predictionWriter(env,()=>moodBackfill(env,body));
 if(path==='/api/enrichment/schema'&&request.method==='GET')return json({profile:{schemaVersion:1,required:['ratingScale','positiveSignals','negativeSignals','characterLogic','pace','payoffEnding','genrePreferences','comedyPreferences','horrorPreferences','scifiAdventurePreferences','actionPreferences','anchorFilms','hardSkips','calibration'],textFields:['ratingScale','characterLogic','pace','payoffEnding','genrePreferences','comedyPreferences','horrorPreferences','scifiAdventurePreferences','actionPreferences','calibration'],listFields:['positiveSignals','negativeSignals','hardSkips'],anchorFilms:{title:'string',rating:'0.5…5.0 in 0.5 steps',reason:'string'}},fingerprint:{fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,plotMechanics:MECHANICS,execution:EXECUTION,requiredExecution:Object.keys(EXECUTION).slice(0,13),moodLabels:'2–4 short labels, preferably canonical vocabulary labels; raw input preserved and mapped at write',moodVocabulary:MOOD_LABELS,strengths:'short string array',risks:'short string array',confidence:['low','medium','high'],sourceBasis:['metadata','model_knowledge','web_research','mixed'],sourceRefs:'URL or model_knowledge'},prediction:{predictedRating:'0.5…5.0 in 0.5 steps',probability4Plus:'number 0…1',confidence:['low','medium','high'],matchSignals:'0–3 short strings',mainRisk:'one short string or null',moodLabels:'2–4 short labels, preferably canonical vocabulary labels; raw input preserved and mapped at write',moodVocabulary:MOOD_LABELS},rules:['Do not infer execution quality from premise alone; use unknown if evidence is insufficient','Do not use or request actual user rating for the target film']});
 if(path==='/api/enrichment/view'&&request.method==='GET')return json(await enrichmentView(env));
 if(path==='/api/enrichment/fingerprint-view/backfill'&&request.method==='POST')return backfillFingerprintView(env,body);
 if(path==='/api/enrichment/actual-ratings'&&request.method==='PUT'){if(!Array.isArray(body.items)||body.items.length>100)return json({error:'Expected items (max 100)'},400);const results=[];for(const item of body.items){const id=String(item?.filmId||''),rating=item?.rating;if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id)||!(rating===null||Number.isFinite(rating)&&rating>=.5&&rating<=5&&rating*2%1===0)){results.push({filmId:id,error:'Invalid film or rating'});continue;}await saveJSON(env,filmKey(id)+'actual.json',{rating,source:'letterboxd',updatedAt:new Date().toISOString()});await updateViewIndex(env,id,{actualRating:rating});results.push({filmId:id,status:'saved'});}return json({results});}
 if(path==='/api/enrichment/ratings/backfill'&&request.method==='POST')return ratingsBackfill(env,body);
 return json({error:'Not found'},404);
}
