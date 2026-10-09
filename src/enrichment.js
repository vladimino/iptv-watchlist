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
async function updateViewIndex(env,id,changes){const key=ENRICHMENT_KEY+'view-index.json',index=await loadJSON(env,key)||{};index[id]={...(index[id]||{}),...changes};await saveJSON(env,key,index);}
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
function allEnrichmentFilms(report,catalog){const watchlist=eligibleEnrichmentFilms(report),knownTmdb=new Set(watchlist.map(f=>String(f.tmdbId||'')).filter(Boolean));return [...watchlist,...Object.values(catalog||{}).filter(f=>!knownTmdb.has(String(f.tmdbId)))].sort((a,b)=>String(a.id).localeCompare(String(b.id),'en'));}
function modelMetadata(film){return {id:String(film.id),letterboxdUri:film.url?.startsWith('https://letterboxd.com/')?film.url:null,tmdbUri:film.tmdbId?'https://www.themoviedb.org/movie/'+film.tmdbId:null,title:film.title,original:film.original,year:film.year,genres:film.genres,synopsis:film.synopsis,directors:film.directors,actors:film.actors,runtime:film.runtime||null};}
async function tmdbRequest(env,path){const response=await fetch('https://api.themoviedb.org/3/'+path,{headers:{Authorization:'Bearer '+env.TMDB_API_READ_ACCESS_TOKEN,Accept:'application/json'},signal:AbortSignal.timeout(12000)});if(!response.ok)throw new Error('TMDB HTTP '+response.status);return response.json();}
async function resolveDiscoveryBatch(env,report,limit=24){
 if(!env.TMDB_API_READ_ACCESS_TOKEN)return {stage:'missing_secret',checked:0,remaining:null};
 const [source,resolution,catalog]=await Promise.all([loadJSON(env,'epg/discovery-latest.json'),loadJSON(env,'epg/discovery-resolution.json'),loadJSON(env,'epg/discovered-films.json')]);
 if(!source?.items)return {stage:'awaiting_epg_discovery',checked:0,remaining:null};
 const decisions=resolution||{},films=catalog||{},knownTmdb=new Map((report.films||[]).filter(f=>f.tmdbId).map(f=>[String(f.tmdbId),String(f.id)]));
 const aliasIndex=new Map(),indexFilm=film=>{if(!film?.year||!film?.tmdbId)return;const identity={...film,id:knownTmdb.get(String(film.tmdbId))||film.id};for(const alias of new Set([film.title,film.original,...(film.aliases||[])])){const key=norm(alias)+'|'+film.year;if(key==='|'+film.year)continue;const ids=aliasIndex.get(key)||new Map();ids.set(String(film.tmdbId),identity);aliasIndex.set(key,ids);}};
 for(const film of [...Object.values(films),...(report.films||[])])indexFilm(film);
 const cutoff=Date.parse(report.updatedAt)||Date.now(),available=c=>Number(c.lastAiring>=cutoff-72*3600000&&c.lastAiring<cutoff+24*3600000);
 const unresolved=source.items.filter(c=>!decisions[c.key]);let screenedOut=0;
 for(const candidate of unresolved){const reason=nonFilmEPGReason(candidate.title);if(!reason)continue;decisions[candidate.key]={status:'excluded_nonfilm',reason,checkedAt:new Date().toISOString()};screenedOut++;}
 if(screenedOut)await saveJSON(env,'epg/discovery-resolution.json',decisions);
 const pending=unresolved.filter(c=>!decisions[c.key]).sort((a,b)=>available(b)-available(a)||Number(!!b.year)-Number(!!a.year)||b.lastAiring-a.lastAiring);
 let checked=0,added=0,reused=0,error=null,dirty=0,catalogDirty=false,tmdbCalls=0;
 const queryTmdb=async path=>{tmdbCalls++;return tmdbRequest(env,path);};
 const checkpoint=async()=>{if(!dirty)return;if(catalogDirty)await saveJSON(env,'epg/discovered-films.json',films);await saveJSON(env,'epg/discovery-resolution.json',decisions);dirty=0;catalogDirty=false;};
 for(const candidate of pending.slice(0,limit)){
  try{
   if(candidate.year){const matches=[...(aliasIndex.get(candidate.normalizedTitle+'|'+candidate.year)?.values()||[])].filter(film=>film.runtime&&(candidate.durations||[candidate.duration]).some(minutes=>Math.abs(film.runtime-minutes)<=Math.max(8,film.runtime*.08)));if(matches.length===1){const film=matches[0];decisions[candidate.key]={status:'verified',filmId:String(film.id),tmdbId:String(film.tmdbId),identitySource:'known_alias_year_runtime',checkedAt:new Date().toISOString()};checked++;reused++;dirty++;if(dirty>=4)await checkpoint();continue;}}
   if(tmdbCalls>=46)break;
   const languages=/[іїєґ]/i.test(candidate.title)?['uk-UA','ru-RU']:['ru-RU','uk-UA'];let search=null,exact=[],deferred=false;
   for(const language of languages){if(tmdbCalls>=48){deferred=true;break;}const query=new URLSearchParams({query:candidate.title,language,include_adult:'false',...(candidate.year?{year:String(candidate.year)}:{})});search=await queryTmdb('search/movie?'+query);exact=(search.results||[]).filter(movie=>[movie.title,movie.original_title].some(title=>norm(title)===candidate.normalizedTitle)&&(!candidate.year||Math.abs(Number(movie.release_date?.slice(0,4))-candidate.year)<=1));if(exact.length)break;}
   if(deferred)break;
   let status='no_confident_match',movie=null;
   if(exact.length===1&&(candidate.year||search.total_pages<=1)){
    if(tmdbCalls>=48)break;
    movie=await queryTmdb('movie/'+exact[0].id+'?language=ru-RU&append_to_response=credits,translations,alternative_titles');
    const tolerance=candidate.year?Math.max(25,movie.runtime*.2):Math.max(10,movie.runtime*.12),durationMatch=movie.runtime&&(candidate.durations||[candidate.duration]).some(minutes=>Math.abs(movie.runtime-minutes)<=tolerance);
    if(movie.id===exact[0].id&&durationMatch){status='verified';const id=knownTmdb.get(String(movie.id))||'tmdb_'+movie.id;
     if(!knownTmdb.has(String(movie.id))){const people=(entries,prefix)=>(entries||[]).slice(0,10).map(p=>({id:prefix+'/'+p.id,name:p.name,original:p.name}));if(!films[id])added++;const localized=(movie.translations?.translations||[]).filter(t=>['ru','uk','en'].includes(t.iso_639_1)).map(t=>t.data?.title),alternates=(movie.alternative_titles?.titles||[]).filter(t=>['RU','UA','US','GB'].includes(t.iso_3166_1)).map(t=>t.title);films[id]={id,tmdbId:String(movie.id),url:'https://www.themoviedb.org/movie/'+movie.id,title:movie.title||candidate.title,original:movie.original_title||candidate.title,aliases:[...new Set([...(films[id]?.aliases||[]),candidate.title,movie.title,movie.original_title,...localized,...alternates].filter(Boolean))].slice(0,40),year:Number(movie.release_date?.slice(0,4))||candidate.year,genres:(movie.genres||[]).map(g=>g.name),synopsis:movie.overview||candidate.description||null,runtime:movie.runtime,directors:people((movie.credits?.crew||[]).filter(p=>p.job==='Director'),'tmdb_director'),actors:people(movie.credits?.cast,'tmdb_actor'),epgLastAiring:Math.max(films[id]?.epgLastAiring||0,candidate.lastAiring)};catalogDirty=true;indexFilm(films[id]);}
     decisions[candidate.key]={status,filmId:id,tmdbId:String(movie.id),checkedAt:new Date().toISOString()};
    }else status='duration_mismatch';
   }else if(exact.length>1)status='ambiguous';
   if(status!=='verified')decisions[candidate.key]={status,checkedAt:new Date().toISOString()};
   checked++;dirty++;if(dirty>=4)await checkpoint();
  }catch(e){error=String(e.message).slice(0,120);break;}
 }
 try{await checkpoint();}catch(e){error=String(e.message).slice(0,120);}
 const summary={stage:error?'partial':'complete',checked:checked+screenedOut,screenedOut,reused,tmdbCalls,added,remaining:Math.max(0,pending.length-checked),error,at:new Date().toISOString(),programmeRunId:source.programmeRunId};await saveJSON(env,'epg/discovery-status.json',summary);return summary;
}
const nextCatchUpAt=()=>new Date(Math.floor(Date.now()/3600000+1)*3600000).toISOString();
function indexedPredictionCurrent(item,profile){const p=item?.prediction;return !!p&&p.tasteProfileVersion===profile.version&&p.tasteProfileHash===profile.profileHash&&p.fingerprintHash===item.fingerprintHash&&p.fingerprintSchemaVersion===FINGERPRINT_SCHEMA_VERSION&&p.predictionPromptVersion===PREDICTION_PROMPT_VERSION;}
async function refreshPredictionQueue(env,report,trigger='reconcile'){
 const [profile,index,previous,catalog]=await Promise.all([loadJSON(env,profileKey),loadJSON(env,ENRICHMENT_KEY+'view-index.json'),loadJSON(env,predictionQueueKey),loadJSON(env,'epg/discovered-films.json')]);
 if(!profile||!report?.films)return null;
 const cutoff=Date.parse(report.updatedAt)||Date.now(),films=allEnrichmentFilms(report,catalog),needed=films.filter(f=>!indexedPredictionCurrent(index?.[String(f.id)],profile));
 const rank=f=>{const available=(f.shows||[]).some(s=>s.start>=cutoff-72*3600000&&s.start<cutoff+24*3600000)||f.epgLastAiring>=cutoff-72*3600000&&f.epgLastAiring<cutoff+24*3600000;return (available?0:2)+(index?.[String(f.id)]?.prediction?1:0);};
 needed.sort((a,b)=>rank(a)-rank(b)||String(a.id).localeCompare(String(b.id),'en'));
 const queue={schemaVersion:1,profileVersion:profile.version,profileHash:profile.profileHash,programmeRunId:report.runId,refreshedAt:new Date().toISOString(),trigger,pending:needed.map(f=>String(f.id)),priorityCount:needed.filter(f=>rank(f)<2).length,lastBatch:previous?.lastBatch||null,lastCheckAt:previous?.lastCheckAt||null};
 await saveJSON(env,predictionQueueKey,queue);return queue;
}
async function queueStatus(env){const queue=await loadJSON(env,predictionQueueKey);return queue?{profileVersion:queue.profileVersion,programmeRunId:queue.programmeRunId,refreshedAt:queue.refreshedAt,pendingCount:queue.pending.length,priorityCount:queue.priorityCount,lastBatch:queue.lastBatch,lastCheckAt:queue.lastCheckAt,nextCatchUpAt:nextCatchUpAt()}:null;}
async function enrichmentStart(env,body){
 const mode=body.mode||'queued',batchSize=body.batchSize||4;
 if(!['watchlist_available','watchlist_all'].includes(body?.scope)||(body.limit!==undefined&&(!Number.isInteger(body.limit)||body.limit<1))||!['queued','legacy'].includes(mode)||(mode==='queued'&&(!Number.isInteger(batchSize)||batchSize<1||batchSize>5)))return json({error:'Invalid scope, mode or batchSize'},400);
 const [profile,report,sync]=await Promise.all([loadJSON(env,profileKey),loadJSON(env,'programme.json'),loadJSON(env,'sync.json')]);if(!profile)return json({error:'Taste profile is not configured'},409);if(!report?.runId||!report?.films||!sync||sync.stage!=='complete'&&sync.runId===report.runId)return json({error:'No completed programme snapshot'},409);
 let discovery=null;if(mode==='queued')try{discovery=await resolveDiscoveryBatch(env,report);}catch(e){discovery={stage:'error',error:String(e.message).slice(0,120)};}
 const catalog=mode==='queued'?await loadJSON(env,'epg/discovered-films.json'):null,eligible=mode==='queued'?allEnrichmentFilms(report,catalog):eligibleEnrichmentFilms(report),queue=mode==='queued'?await refreshPredictionQueue(env,report,body.trigger==='scheduled'?'scheduled':'manual'):null;
 const previous=await loadJSON(env,ENRICHMENT_KEY+'latest-run.json');
 if(mode==='queued'&&previous?.status==='running'&&previous.mode==='queued'&&previous.tasteProfileHash===profile.profileHash&&Date.now()-Date.parse(previous.lastActivityAt||previous.createdAt)<30*60000)return json({...runSummary(previous),pendingCount:queue.pending.length,nextCatchUpAt:nextCatchUpAt()});
 if(mode==='queued'&&previous?.status==='running'&&previous.mode==='queued'){previous.interruption=previous.tasteProfileHash===profile.profileHash?'lease_expired_or_quota':'profile_changed';await enrichmentComplete(env,{runId:previous.runId,reason:previous.interruption});}
 const selected=mode==='queued'?queue.pending.slice(0,batchSize).map(id=>eligible.find(f=>String(f.id)===id)).filter(Boolean):body.limit===undefined?eligible:eligible.slice(0,body.limit);
 if(mode==='queued'&&!selected.length){const at=new Date().toISOString();queue.lastCheckAt=at;queue.lastBatch={runId:null,trigger:body.trigger==='scheduled'?'scheduled':'manual',startedAt:at,finishedAt:at,stage:'noop',profileVersion:profile.version,checked:0,added:0,updated:0,failed:0,remaining:0,discovery,reason:null};await saveJSON(env,predictionQueueKey,queue);return json({status:'noop',checked:0,added:0,updated:0,failed:0,remaining:0,discovery,profileVersion:profile.version,nextCatchUpAt:nextCatchUpAt()});}
 const states=await Promise.all(selected.map(f=>readFilmState(env,f.id)));const baseline=Object.fromEntries(selected.map((f,i)=>[String(f.id),states[i].predictions?.current?.generatedAt||null]));const pendingCount=mode==='queued'?queue.pending.length:states.filter((s)=>!predictionCurrent(s.predictions?.current,profile,s.fingerprint)).length;
 if(mode!=='queued'&&previous?.status==='running'&&previous.sourceProgrammeRunId===report.runId&&previous.tasteProfileHash===profile.profileHash&&previous.selectedIds?.join('|')===selected.map(f=>String(f.id)).join('|'))return json({...runSummary(previous),pendingCount});
 const run={runId:crypto.randomUUID(),status:'running',mode,trigger:body.trigger==='scheduled'?'scheduled':'manual',createdAt:new Date().toISOString(),lastActivityAt:new Date().toISOString(),sourceProgrammeRunId:report.runId,tasteProfileVersion:profile.version,tasteProfileHash:profile.profileHash,fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,predictionPromptVersion:PREDICTION_PROMPT_VERSION,eligibleCount:eligible.length,selectedIds:selected.map(f=>String(f.id)),baseline,failures:{},results:{}};await saveJSON(env,ENRICHMENT_KEY+'sources/'+run.runId+'.json',Object.fromEntries(selected.map(f=>[String(f.id),modelMetadata(f)])));await saveJSON(env,runKey(run.runId),run);await saveJSON(env,ENRICHMENT_KEY+'latest-run.json',run);return json({...runSummary(run),pendingCount,nextCatchUpAt:nextCatchUpAt()});
}
function runSummary(r){return {runId:r.runId,sourceProgrammeRunId:r.sourceProgrammeRunId,tasteProfileVersion:r.tasteProfileVersion,tasteProfileHash:r.tasteProfileHash,fingerprintSchemaVersion:r.fingerprintSchemaVersion,predictionPromptVersion:r.predictionPromptVersion,eligibleCount:r.eligibleCount,selectedCount:r.selectedIds.length,status:r.status,trigger:r.trigger||'manual',startedAt:r.createdAt,finishedAt:r.completedAt||null,checked:Object.keys(r.results||{}).length,added:Object.values(r.results||{}).filter(x=>x==='created').length,updated:Object.values(r.results||{}).filter(x=>x==='recalculated').length,failed:Object.keys(r.failures||{}).length};}
async function checkedRun(env,id){if(!isText(id,100))return null;return loadJSON(env,runKey(id));}
async function enrichmentNext(env,body){
 const run=await checkedRun(env,body?.runId);if(!run)return json({error:'Unknown run'},404);if(run.status!=='running')return json({error:'Run already complete'},409);if(!Number.isInteger(body.batchSize)||body.batchSize<1||body.batchSize>10)return json({error:'Invalid batchSize'},400);
 const profile=await loadJSON(env,profileKey);if(profile?.profileHash!==run.tasteProfileHash)return json({error:'Profile changed; start a new run'},409);
 const source=await loadJSON(env,ENRICHMENT_KEY+'sources/'+run.runId+'.json')||{};const states=await Promise.all(run.selectedIds.map(id=>readFilmState(env,id)));const items=[];let pendingCount=0;
 const index=await loadJSON(env,ENRICHMENT_KEY+'view-index.json')||{};let repair=false;for(let i=0;i<run.selectedIds.length;i++){const id=run.selectedIds[i],s=states[i],p=s.predictions?.current;if(p&&index[id]?.prediction?.generatedAt!==p.generatedAt){index[id]={...(index[id]||{}),prediction:p,fingerprintHash:s.fingerprint?.fingerprintHash||null};repair=true;}}if(repair)await saveJSON(env,ENRICHMENT_KEY+'view-index.json',index);
 for(let i=0;i<run.selectedIds.length;i++){const id=run.selectedIds[i],s=states[i];if(predictionCurrent(s.predictions?.current,profile,s.fingerprint)||run.failures[id])continue;pendingCount++;if(items.length>=body.batchSize)continue;const film=source[id];if(!film)continue;const requiredWork=fingerprintCurrent(s.fingerprint)?'prediction_only':'fingerprint_and_prediction';const item={filmId:id,requiredWork};if(requiredWork==='prediction_only')item.fingerprint=s.fingerprint;else item.metadata=film;items.push(item);}
 return json({runId:run.runId,profile:profile.profile,profileVersion:profile.version,profileHash:profile.profileHash,fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,predictionPromptVersion:PREDICTION_PROMPT_VERSION,items,pendingCount});
}
async function enrichmentSubmit(env,body){
 const run=await checkedRun(env,body?.runId);if(!run)return json({error:'Unknown run'},404);if(run.status!=='running')return json({error:'Run already complete'},409);if(!Array.isArray(body.items)||!body.items.length||body.items.length>10)return json({error:'Expected 1–10 items'},400);
 const profile=await loadJSON(env,profileKey);if(profile?.profileHash!==run.tasteProfileHash)return json({error:'Profile changed; start a new run'},409);
 const results=[];for(const item of body.items){const id=String(item?.filmId||'');if(!run.selectedIds.includes(id)){results.push({filmId:id,error:'Film not selected'});continue;}try{
   const state=await readFilmState(env,id);let fingerprint=state.fingerprint;if(item.fingerprint){const issue=validateFingerprint(item.fingerprint);if(issue)throw new Error(issue);const value={...item.fingerprint,filmId:id,generatedAt:new Date().toISOString(),invalidatedAt:null};value.fingerprintHash=await contentHash({...item.fingerprint,filmId:id});if(!fingerprintCurrent(fingerprint)||fingerprint.fingerprintHash!==value.fingerprintHash){await saveJSON(env,filmKey(id)+'fingerprint.json',value);fingerprint=value;await updateViewIndex(env,id,{fingerprintHash:value.fingerprintHash,fingerprint:fingerprintFacet(value)});}}
   if(!fingerprintCurrent(fingerprint))throw new Error('Current fingerprint required');if(predictionCurrent(state.predictions?.current,profile,fingerprint)){await updateViewIndex(env,id,{prediction:state.predictions.current,fingerprintHash:fingerprint.fingerprintHash,fingerprint:fingerprintFacet(fingerprint)});results.push({filmId:id,status:'already_current'});delete run.failures[id];continue;}
   const issue=validatePrediction(item.prediction);if(issue)throw new Error(issue);
   const at=new Date().toISOString(),prediction={...item.prediction,filmId:id,generatedAt:at,tasteProfileVersion:profile.version,tasteProfileHash:profile.profileHash,fingerprintHash:fingerprint.fingerprintHash,fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,predictionPromptVersion:PREDICTION_PROMPT_VERSION};const old=state.predictions?.current;const history=[...(state.predictions?.history||[])];if(old)history.push({...old,replacedAt:at});await saveJSON(env,filmKey(id)+'predictions.json',{current:prediction,history});await updateViewIndex(env,id,{prediction,fingerprintHash:fingerprint.fingerprintHash,fingerprint:fingerprintFacet(fingerprint)});delete run.failures[id];results.push({filmId:id,status:old?'recalculated':'created'});
  }catch(e){run.failures[id]=String(e.message).slice(0,300);results.push({filmId:id,error:run.failures[id]});}}
 run.results ||= {};for(const result of results)if(result.filmId)run.results[result.filmId]=result.status||'failed';run.lastActivityAt=new Date().toISOString();
 await saveJSON(env,runKey(run.runId),run);await saveJSON(env,ENRICHMENT_KEY+'latest-run.json',run);
 let remaining=null;if(run.mode==='queued'){const report=await loadJSON(env,'programme.json'),queue=await refreshPredictionQueue(env,report,'batch_progress');remaining=queue?.pending.length??null;}
 return json({runId:run.runId,results,checked:Object.keys(run.results).length,added:Object.values(run.results).filter(x=>x==='created').length,updated:Object.values(run.results).filter(x=>x==='recalculated').length,failed:Object.keys(run.failures).length,remaining,nextCatchUpAt:nextCatchUpAt()});
}
async function enrichmentComplete(env,body){
 const run=await checkedRun(env,body?.runId);if(!run)return json({error:'Unknown run'},404);if(run.status==='complete'||run.status==='partial'){await saveJSON(env,ENRICHMENT_KEY+'latest-run.json',run);await writeEvent(env,{id:'enrichment-'+run.runId,type:'enrichment',at:run.completedAt,...run.counts});return json({runId:run.runId,status:run.status,counts:run.counts});}
 const profile=await loadJSON(env,profileKey);if(profile?.profileHash!==run.tasteProfileHash&&!body.reason)return json({error:'Profile changed; start a new run'},409);const states=await Promise.all(run.selectedIds.map(id=>readFilmState(env,id)));let created=0,recalculated=0,pending=0;for(let i=0;i<states.length;i++){const s=states[i],p=s.predictions?.current,id=run.selectedIds[i];if(p?.generatedAt&&p.generatedAt!==run.baseline[id]&&p.tasteProfileHash===run.tasteProfileHash&&p.predictionPromptVersion===run.predictionPromptVersion){run.baseline[id]?recalculated++:created++;}else if(!run.failures[id]&&!predictionCurrent(p,profile,s.fingerprint))pending++;}
 const failed=Object.keys(run.failures).length;run.counts={created,recalculated,failed,pending};run.status=failed||pending||body.reason?'partial':'complete';run.completedAt=new Date().toISOString();run.reason=isText(body.reason,200)?body.reason:run.interruption||null;
 let remaining=pending;if(run.mode==='queued'){const report=await loadJSON(env,'programme.json'),queue=await refreshPredictionQueue(env,report,'batch_complete');remaining=queue?.pending.length??pending;if(queue){queue.lastBatch={runId:run.runId,trigger:run.trigger,startedAt:run.createdAt,finishedAt:run.completedAt,stage:run.status,profileVersion:run.tasteProfileVersion,checked:Object.keys(run.results||{}).length,added:created,updated:recalculated,failed,remaining,reason:run.reason};queue.lastCheckAt=run.completedAt;await saveJSON(env,predictionQueueKey,queue);}}
 await saveJSON(env,runKey(run.runId),run);await saveJSON(env,ENRICHMENT_KEY+'latest-run.json',run);const event={id:'enrichment-'+run.runId,type:'enrichment',at:run.completedAt,...run.counts,checked:Object.keys(run.results||{}).length,added:created,updated:recalculated,remaining,trigger:run.trigger,stage:run.status,reason:run.reason,nextCatchUpAt:nextCatchUpAt()};await writeEvent(env,event);return json({runId:run.runId,status:run.status,counts:run.counts,checked:event.checked,added:created,updated:recalculated,failed,remaining,nextCatchUpAt:event.nextCatchUpAt});
}
async function enrichmentStatus(env){const [profile,run,report,queue,catalog,discovery]=await Promise.all([loadJSON(env,profileKey),loadJSON(env,ENRICHMENT_KEY+'latest-run.json'),loadJSON(env,'programme.json'),queueStatus(env),loadJSON(env,'epg/discovered-films.json'),loadJSON(env,'epg/discovery-status.json')]);const films=report?allEnrichmentFilms(report,catalog):[];return {profileVersion:profile?.version||null,fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,predictionPromptVersion:PREDICTION_PROMPT_VERSION,lastRun:run?{...runSummary(run),counts:run.counts||null,failures:run.failures,reason:run.reason||null,completedAt:run.completedAt||null}:null,selectedCount:films.length,pendingCount:queue?.pendingCount??null,discovery:discovery||null,queue};}
async function enrichmentView(env){const [profile,index]=await Promise.all([loadJSON(env,profileKey),ensureInitialRatings(env)]);return {profile:profile?{version:profile.version,updatedAt:profile.updatedAt}:null,films:Object.fromEntries(Object.entries(index||{}).map(([id,item])=>{const p=item.prediction,f=item.fingerprint;return [id,{fingerprint:f&&f.fingerprintHash===item.fingerprintHash?{plotMechanics:f.plotMechanics||[],moodLabels:f.moodLabels||[]}:null,prediction:p?{predictedRating:p.predictedRating,probability4Plus:p.probability4Plus,confidence:p.confidence,matchSignals:p.matchSignals,mainRisk:p.mainRisk,moodLabels:p.moodLabels,stale:!profile||p.tasteProfileVersion!==profile.version||p.tasteProfileHash!==profile.profileHash||p.fingerprintHash!==item.fingerprintHash||p.predictionPromptVersion!==PREDICTION_PROMPT_VERSION||p.fingerprintSchemaVersion!==FINGERPRINT_SCHEMA_VERSION}:null,actualRating:item.actualRating??null}];}))};}
async function backfillFingerprintView(env,body){const [index,report,catalog]=await Promise.all([ensureInitialRatings(env),loadJSON(env,'programme.json'),loadJSON(env,'epg/discovered-films.json')]),ids=[...new Set([...Object.keys(index),...allEnrichmentFilms(report||{films:[]},catalog).map(f=>String(f.id))])].sort(),cursor=String(body.cursor||'');if(body.limit!==undefined&&(!Number.isInteger(body.limit)||body.limit<1||body.limit>100))return json({error:'Invalid limit'},400);const selected=ids.filter(id=>id>cursor).slice(0,body.limit||80),fingerprints=await Promise.all(selected.map(id=>loadJSON(env,filmKey(id)+'fingerprint.json')));let added=0,updated=0;for(let i=0;i<selected.length;i++){const id=selected[i],facet=fingerprintFacet(fingerprints[i]);if(!facet||index[id]?.fingerprint?.fingerprintHash===facet.fingerprintHash)continue;const existed=!!index[id]?.fingerprint;index[id]={...(index[id]||{}),fingerprintHash:facet.fingerprintHash,fingerprint:facet};existed?updated++:added++;}if(added||updated)await saveJSON(env,ENRICHMENT_KEY+'view-index.json',index);return json({checked:selected.length,added,updated,nextCursor:selected.length&&ids.some(id=>id>selected.at(-1))?selected.at(-1):null});}
async function enrichmentRoute(request,env,url){const path=url.pathname;let body=null;if(['POST','PUT'].includes(request.method)){try{body=await request.json();}catch{return json({error:'Invalid JSON'},400);}if(!isObject(body))return json({error:'Invalid request'},400);}
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
  return json(await resolveDiscoveryBatch(env,report,body.limit||24));
 }
 if(path==='/api/enrichment/discovery/scan'&&request.method==='POST'){
  const report=await loadJSON(env,'programme.json');if(!report?.films)return json({error:'No programme'},409);
  const now=Date.now(),response=await fetch('https://example.invalid/epg.xml',{signal:AbortSignal.timeout(110000)});if(!response.ok)return json({error:'EPG HTTP '+response.status},502);
  const result=await scanEPG(response.body,report.films,now);if(result.stats.epgEnd<now+8*3600000)return json({error:'EPG horizon too short'},502);
  const old=await loadJSON(env,'epg/discovery-latest.json'),items=mergeDiscoveryCandidates(old?.items,result.discovery);await saveJSON(env,'epg/discovery-latest.json',{programmeRunId:report.runId,updatedAt:new Date(now).toISOString(),items});return json({programmeRunId:report.runId,candidates:items.length,newCandidates:items.length-(old?.items?.length||0),scanned:result.stats.scanned});
 }
 if(path==='/api/enrichment/discovery/status'&&request.method==='GET'){
  const [source,decisions,catalog,last]=await Promise.all([loadJSON(env,'epg/discovery-latest.json'),loadJSON(env,'epg/discovery-resolution.json'),loadJSON(env,'epg/discovered-films.json'),loadJSON(env,'epg/discovery-status.json')]);const current=new Set((source?.items||[]).map(c=>c.key)),statuses={};for(const [key,value] of Object.entries(decisions||{}))if(current.has(key))statuses[value.status]=(statuses[value.status]||0)+1;
  return json({programmeRunId:source?.programmeRunId||null,updatedAt:source?.updatedAt||null,candidates:current.size,checked:Object.values(statuses).reduce((a,b)=>a+b,0),pending:current.size-Object.values(statuses).reduce((a,b)=>a+b,0),verifiedFilms:Object.keys(catalog||{}).length,statuses,lastBatch:last||null});
 }
 if(path==='/api/enrichment/diagnostics/freeze'&&request.method==='POST'){const result=await freezeDiagnosticSnapshot(env);return result.error?json({error:result.error},409):json({created:result.created,frozenAt:result.snapshot.frozenAt,programmeRunId:result.snapshot.programmeRunId,filmCount:result.snapshot.films.length,predictionCount:result.snapshot.films.filter(f=>!!f.prediction).length});}
 if(path==='/api/enrichment/diagnostics/snapshot'&&request.method==='GET'){const snapshot=await loadJSON(env,diagnosticSnapshotKey);return snapshot?json(snapshot):json({error:'No frozen diagnostic snapshot'},404);}
 if(path==='/api/enrichment/diagnostics/accuracy'&&request.method==='GET'){const snapshot=await loadJSON(env,diagnosticSnapshotKey);return snapshot?json(prospectiveAccuracy(snapshot,await loadJSON(env,ratingObservationsKey)||[])):json({error:'No frozen diagnostic snapshot'},404);}
 if(path==='/api/enrichment/profile'&&request.method==='GET'){const p=await loadJSON(env,profileKey);return p?json(p):json({error:'Taste profile is not configured'},404);}
 if(path==='/api/enrichment/profile'&&request.method==='PUT'){if(body.schemaVersion!==1||!Number.isInteger(body.version)||body.version<1)return json({error:'Invalid version or schemaVersion'},400);const issue=validateProfile(body.profile);if(issue)return json({error:issue},400);const current=await loadJSON(env,profileKey);if(current&&body.version<=current.version)return json({error:'Version must increase'},409);const value={version:body.version,schemaVersion:1,updatedAt:new Date().toISOString(),profileHash:await contentHash(body.profile),profile:body.profile};await saveJSON(env,ENRICHMENT_KEY+'profile/versions/'+body.version+'.json',value);await saveJSON(env,profileKey,value);try{await refreshPredictionQueue(env,await loadJSON(env,'programme.json'),'profile_updated');}catch{}return json(value);}
 if(path==='/api/enrichment/start'&&request.method==='POST')return enrichmentStart(env,body);
 if(path==='/api/enrichment/queue/reconcile'&&request.method==='POST'){const report=await loadJSON(env,'programme.json');const queue=await refreshPredictionQueue(env,report,'manual_reconcile');return queue?json(await queueStatus(env)):json({error:'Programme or taste profile unavailable'},409);}
 if(path==='/api/enrichment/queue/status'&&request.method==='GET')return json(await queueStatus(env)||{status:'not_initialized',pendingCount:null,nextCatchUpAt:nextCatchUpAt()});
 if(path==='/api/enrichment/next'&&request.method==='POST')return enrichmentNext(env,body);
 if(path==='/api/enrichment/submit'&&request.method==='POST')return enrichmentSubmit(env,body);
 if(path==='/api/enrichment/complete'&&request.method==='POST')return enrichmentComplete(env,body);
 if(path==='/api/enrichment/status'&&request.method==='GET')return json(await enrichmentStatus(env));
 if(path==='/api/enrichment/schema'&&request.method==='GET')return json({profile:{schemaVersion:1,required:['ratingScale','positiveSignals','negativeSignals','characterLogic','pace','payoffEnding','genrePreferences','comedyPreferences','horrorPreferences','scifiAdventurePreferences','actionPreferences','anchorFilms','hardSkips','calibration'],textFields:['ratingScale','characterLogic','pace','payoffEnding','genrePreferences','comedyPreferences','horrorPreferences','scifiAdventurePreferences','actionPreferences','calibration'],listFields:['positiveSignals','negativeSignals','hardSkips'],anchorFilms:{title:'string',rating:'0.5…5.0 in 0.5 steps',reason:'string'}},fingerprint:{fingerprintSchemaVersion:FINGERPRINT_SCHEMA_VERSION,plotMechanics:MECHANICS,execution:EXECUTION,requiredExecution:Object.keys(EXECUTION).slice(0,13),moodLabels:'2–4 short labels',strengths:'short string array',risks:'short string array',confidence:['low','medium','high'],sourceBasis:['metadata','model_knowledge','web_research','mixed'],sourceRefs:'URL or model_knowledge'},prediction:{predictedRating:'0.5…5.0 in 0.5 steps',probability4Plus:'number 0…1',confidence:['low','medium','high'],matchSignals:'0–3 short strings',mainRisk:'one short string or null',moodLabels:'2–4 short labels'},rules:['Do not infer execution quality from premise alone; use unknown if evidence is insufficient','Do not use or request actual user rating for the target film']});
 if(path==='/api/enrichment/view'&&request.method==='GET')return json(await enrichmentView(env));
 if(path==='/api/enrichment/fingerprint-view/backfill'&&request.method==='POST')return backfillFingerprintView(env,body);
 if(path==='/api/enrichment/actual-ratings'&&request.method==='PUT'){if(!Array.isArray(body.items)||body.items.length>100)return json({error:'Expected items (max 100)'},400);const results=[];for(const item of body.items){const id=String(item?.filmId||''),rating=item?.rating;if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id)||!(rating===null||Number.isFinite(rating)&&rating>=.5&&rating<=5&&rating*2%1===0)){results.push({filmId:id,error:'Invalid film or rating'});continue;}await saveJSON(env,filmKey(id)+'actual.json',{rating,source:'letterboxd',updatedAt:new Date().toISOString()});await updateViewIndex(env,id,{actualRating:rating});results.push({filmId:id,status:'saved'});}return json({results});}
 if(path==='/api/enrichment/ratings/backfill'&&request.method==='POST')return ratingsBackfill(env,body);
 return json({error:'Not found'},404);
}
