// Film and Person lifecycle contract, phase 1 of AIR-42.
// Pure observations and transition guards. This file is not in the Worker bundle.
const DOMAIN_CONTRACT_VERSION=1;
const FINGERPRINT_SCHEMA_VERSION=1;
const PREDICTION_PROMPT_VERSION=1;
const METADATA_FRESH_MS=30*86400000;
const HOT_PAST_MS=72*3600000;
const HOT_FUTURE_MS=24*3600000;
const AVAILABLE_MS=72*3600000;
const IDENTITY_STATUSES=Object.freeze(['unresolved','resolving','resolved','ambiguous','rejected']);
const METADATA_STATUSES=Object.freeze(['missing','fetching','partial','fresh','stale','failed']);
const LOCALIZATION_STATUSES=Object.freeze(['missing','provisional','reviewed']);
const GENERATED_STATUSES=Object.freeze(['missing','generating','current','stale','failed']);
const FILM_DIMENSIONS=Object.freeze(['identity','metadata','localization','fingerprint','prediction']);
const TRANSITIONS={
 identity:{unresolved:['resolving','resolved','ambiguous','rejected'],resolving:['unresolved','resolved','ambiguous','rejected'],ambiguous:['resolving','resolved','unresolved'],resolved:['resolved'],rejected:['rejected']},
 metadata:{missing:['fetching','partial','fresh','failed'],fetching:['missing','partial','fresh','stale','failed'],partial:['fetching','fresh','stale','failed','partial'],fresh:['fetching','partial','stale','failed','fresh'],stale:['fetching','fresh','partial','failed'],failed:['fetching','missing','partial','fresh']},
 localization:{missing:['provisional','reviewed'],provisional:['provisional','reviewed'],reviewed:['reviewed']},
 fingerprint:{missing:['generating','current','stale'],generating:['current','failed','missing'],current:['current','stale'],stale:['generating','current','missing','stale'],failed:['generating','missing','stale']},
 prediction:{missing:['generating','current','stale','failed'],generating:['current','failed','missing','stale'],current:['current','stale'],stale:['generating','current','failed','missing','stale'],failed:['generating','stale','missing']}
};

function clock(value){if(typeof value==='number')return value;const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:NaN;}
function stamp(value){if(value==null)return null;return typeof value==='number'?new Date(value).toISOString():value;}
function inFuture(retryAt,now){const retry=clock(retryAt);return Number.isFinite(retry)&&retry>clock(now);}
function uniqueIds(values){const out=[],seen=new Set();for(const value of values||[]){const id=String(value||'');if(!id||seen.has(id))continue;seen.add(id);out.push(id);}return out;}
function reasonText(failure){if(!failure)return null;if(typeof failure==='string')return failure;return failure.error||failure.reason||'failed';}
function dimensionState(dimension,fields){
 if(!TRANSITIONS[dimension]?.[fields.status])throw new Error('unknown '+dimension+' status '+fields.status);
 const state={dimension,status:fields.status,updatedAt:stamp(fields.updatedAt),source:fields.source??null,sourceVersion:fields.sourceVersion??null,provenance:fields.provenance??null,lastError:fields.lastError??null,failureReason:fields.failureReason??null,retryAt:fields.retryAt??null,attempts:fields.attempts??0,nextAction:fields.nextAction??'none'};
 if(dimension==='localization')state.value=fields.value??null;
 return state;
}
function transition(state,status,patch={}){
 if(!(TRANSITIONS[state.dimension][state.status]||[]).includes(status))return {ok:false,reason:'illegal_transition',dimension:state.dimension,from:state.status,to:status,state};
 return {ok:true,state:dimensionState(state.dimension,{...state,...patch,status})};
}
function localFilmId({letterboxdId,tmdbId,conflictingTmdbIds}={}){
 if(letterboxdId)return 'film:'+String(letterboxdId);
 const conflicts=uniqueIds(conflictingTmdbIds);
 if(conflicts.length>1)return 'film:conflict:'+[...conflicts].sort().join('+');
 if(tmdbId)return 'film:tmdb:'+String(tmdbId);
 return null;
}
function localPersonId(roleId){return typeof roleId==='string'&&/^(actor|director|role)\//.test(roleId)?'person:'+roleId:null;}
function externalIds({letterboxdId,tmdbId,conflictingTmdbIds,provenance}={}){
 const ids=[];
 if(letterboxdId)ids.push({scheme:'letterboxd',value:String(letterboxdId),conflicting:false,provenance:provenance?.letterboxd??null});
 const conflicts=uniqueIds(conflictingTmdbIds);
 if(conflicts.length>1){for(const value of conflicts)ids.push({scheme:'tmdb',value,conflicting:true,provenance:provenance?.tmdb??null});}
 else if(tmdbId)ids.push({scheme:'tmdb',value:String(tmdbId),conflicting:false,provenance:provenance?.tmdb??null});
 return ids;
}
function dictionaryApplies(dictionary,tmdbId){return !!dictionary&&(!tmdbId||!dictionary.tmdbId||String(dictionary.tmdbId)===String(tmdbId));}
function provisionalApplies(provisional,tmdbId){return !!provisional?.title&&(!provisional.tmdbId||!tmdbId||String(provisional.tmdbId)===String(tmdbId));}
function mergeAliases(existing=[],incoming=[]){
 const out=[],seen=new Set();
 for(const alias of [...existing,...incoming]){
  if(!alias?.value)continue;
  const key=(alias.kind||'title')+'\0'+alias.value;
  if(seen.has(key))continue;
  seen.add(key);
  out.push({kind:alias.kind||'title',value:alias.value,provenance:alias.provenance??null});
 }
 return out;
}
function identityState(facts){
 const now=facts.now??null,conflicts=uniqueIds(facts.conflictingTmdbIds),decision=facts.decision||null;
 if(decision?.status==='excluded_nonfilm')return null;
 if(conflicts.length>1)return dimensionState('identity',{status:'ambiguous',updatedAt:now,source:'discovery',provenance:{conflictingTmdbIds:conflicts,error:'two verified TMDB ids'},nextAction:'surface_conflict',attempts:decision?.attempts??0});
 if(decision?.status==='ambiguous'){const wait=inFuture(decision.retryAt,now);return dimensionState('identity',{status:'ambiguous',updatedAt:now,source:'discovery',provenance:{reason:decision.reason||'ambiguous'},nextAction:wait?'wait_retry':'continue_discovery',retryAt:decision.retryAt||null,attempts:decision.attempts??0});}
 if(decision&&['no_confident_match','duration_mismatch'].includes(decision.status)){const wait=inFuture(decision.retryAt,now);return dimensionState('identity',{status:'unresolved',updatedAt:now,source:'discovery',provenance:{reason:decision.status},failureReason:decision.status,nextAction:wait?'wait_retry':'continue_discovery',retryAt:decision.retryAt||null,attempts:decision.attempts??0});}
 if(facts.tmdbId&&(!decision||decision.status==='verified'))return dimensionState('identity',{status:'resolved',updatedAt:now,source:decision?'discovery':facts.letterboxdId?'watchlist':'catalog',sourceVersion:'tmdb:'+facts.tmdbId,provenance:{letterboxdId:facts.letterboxdId?String(facts.letterboxdId):null,tmdbId:String(facts.tmdbId)},nextAction:'stop'});
 if(!facts.tmdbId&&(facts.discoveryPending||decision?.status==='due'||decision?.status==='missing'))return dimensionState('identity',{status:'unresolved',updatedAt:now,source:'discovery',provenance:{reason:decision?.status||'missing'},nextAction:'continue_discovery',retryAt:decision?.retryAt||null,attempts:decision?.attempts??0});
 if(facts.letterboxdId&&!facts.tmdbId)return dimensionState('identity',{status:'unresolved',updatedAt:now,source:'letterboxd',provenance:{letterboxdId:String(facts.letterboxdId)},nextAction:'keep_letterboxd_id'});
 return dimensionState('identity',{status:'unresolved',updatedAt:now,source:'discovery',nextAction:'continue_discovery'});
}
function metadataState(facts={}){
 const now=facts.now??null,failure=reasonText(facts.failure);
 if(failure)return dimensionState('metadata',{status:'failed',updatedAt:now,source:'letterboxd',lastError:failure,failureReason:failure,retryAt:facts.failure?.retryAt||null,attempts:facts.failure?.attempts??0,nextAction:'retry_metadata'});
 if(!facts.present)return dimensionState('metadata',{status:'missing',updatedAt:now,source:'letterboxd',nextAction:'fetch_letterboxd_page'});
 if(!metadataFresh(facts.metadataAt,now))return dimensionState('metadata',{status:'stale',updatedAt:facts.metadataAt||now,source:'letterboxd',sourceVersion:facts.metadataAt||null,nextAction:'full_parse'});
 const namesDone=facts.peopleNamesVersion===2,namesAction=namesDone?'none':'localize_names';
 if(facts.peopleVersion===1&&facts.synopsisPresent&&facts.creditsRetained)return dimensionState('metadata',{status:'partial',updatedAt:facts.metadataAt,source:'letterboxd',sourceVersion:facts.metadataAt,provenance:{peopleVersion:1,peopleNamesVersion:facts.peopleNamesVersion??null,creditsRetained:true,namesAttemptFinished:namesDone},nextAction:namesAction});
 if(facts.peopleVersion===1&&facts.synopsisPresent)return dimensionState('metadata',{status:'fresh',updatedAt:facts.metadataAt,source:'letterboxd',sourceVersion:facts.metadataAt,provenance:{peopleVersion:1,peopleNamesVersion:facts.peopleNamesVersion??null,namesAttemptFinished:namesDone},nextAction:namesAction});
 if(facts.peopleVersion===1)return dimensionState('metadata',{status:'partial',updatedAt:facts.metadataAt,source:'letterboxd',sourceVersion:facts.metadataAt,provenance:{synopsis:false},nextAction:'refresh_synopsis'});
 return dimensionState('metadata',{status:'partial',updatedAt:facts.metadataAt,source:'letterboxd',sourceVersion:facts.metadataAt,provenance:{peopleVersion:facts.peopleVersion??null},nextAction:'full_parse'});
}
function metadataFresh(metadataAt,now){const at=clock(metadataAt);return Number.isFinite(at)&&clock(now)-at<=METADATA_FRESH_MS;}
function titleLocalization(facts={}){
 const now=facts.now??null,tmdbId=facts.tmdbId??null;
 if(dictionaryApplies(facts.dictionary,tmdbId)&&facts.dictionary.status==='verified')return dimensionState('localization',{status:'reviewed',updatedAt:now,source:'dictionary',sourceVersion:'verified',value:facts.dictionary.title,provenance:{value:facts.dictionary.title,sources:facts.dictionary.sources||null},nextAction:'keep_reviewed'});
 if(facts.titleStatus==='verified'&&facts.titleRu)return dimensionState('localization',{status:'reviewed',updatedAt:now,source:'dictionary',sourceVersion:'verified',value:facts.titleRu,provenance:{value:facts.titleRu},nextAction:'keep_reviewed'});
 if(dictionaryApplies(facts.dictionary,tmdbId)&&facts.dictionary.status==='provisional')return dimensionState('localization',{status:'provisional',updatedAt:now,source:'dictionary',sourceVersion:facts.dictionary.verification_basis||'provisional',value:facts.dictionary.title||facts.dictionary.name,provenance:{value:facts.dictionary.title||facts.dictionary.name,basis:facts.dictionary.verification_basis||null},nextAction:'keep_provisional'});
 if(provisionalApplies(facts.provisional,tmdbId))return dimensionState('localization',{status:'provisional',updatedAt:now,source:'wikidata',sourceVersion:'provisional',value:facts.provisional.title,provenance:{value:facts.provisional.title,sources:facts.provisional.sources||null},nextAction:'keep_provisional'});
 return dimensionState('localization',{status:'missing',updatedAt:now,source:null,nextAction:tmdbId?'lookup_wikidata_title':'none'});
}
function personLocalization(facts={}){
 const now=facts.now??null,record=facts.dictionary;
 if(record?.status==='verified'||record?.nameStatus==='verified')return dimensionState('localization',{status:'reviewed',updatedAt:now,source:record.source||'dictionary',sourceVersion:'verified',value:record.name,provenance:{value:record.name,sources:record.source?[record.source]:record.sources||null},nextAction:'keep_reviewed'});
 if(record&&(record.status==='provisional'||record.nameStatus==='provisional'))return dimensionState('localization',{status:'provisional',updatedAt:now,source:'dictionary',sourceVersion:record.verification_basis||record.nameVerificationBasis||'provisional',value:record.name,provenance:{value:record.name,basis:record.verification_basis||record.nameVerificationBasis||null},nextAction:'keep_provisional'});
 if(facts.cacheName&&facts.cacheName!==facts.original)return dimensionState('localization',{status:'provisional',updatedAt:now,source:'wikidata',sourceVersion:'provisional',value:facts.cacheName,provenance:{value:facts.cacheName},nextAction:'keep_provisional'});
 return dimensionState('localization',{status:'missing',updatedAt:now,source:null,nextAction:'lookup_wikidata_name'});
}
function fingerprintState(facts={}){
 const now=facts.now??null;
 if(!facts.present)return dimensionState('fingerprint',{status:'missing',updatedAt:now,source:'fingerprint',nextAction:'fingerprint_and_prediction'});
 if(facts.schemaVersion!==FINGERPRINT_SCHEMA_VERSION||facts.invalidatedAt)return dimensionState('fingerprint',{status:'stale',updatedAt:facts.invalidatedAt||now,source:'fingerprint',sourceVersion:facts.schemaVersion??null,provenance:{schemaVersion:facts.schemaVersion??null,invalidatedAt:facts.invalidatedAt||null},nextAction:'fingerprint_and_prediction'});
 return dimensionState('fingerprint',{status:'current',updatedAt:facts.generatedAt||now,source:'fingerprint',sourceVersion:FINGERPRINT_SCHEMA_VERSION,nextAction:'none'});
}
function predictionState(facts={}){
 const now=facts.now??null,failure=reasonText(facts.failure),fingerprintCurrent=facts.fingerprint?.status==='current';
 const next=fingerprintCurrent?'prediction_only':'fingerprint_and_prediction';
 if(failure)return dimensionState('prediction',{status:'failed',updatedAt:now,source:'prediction',lastError:failure,failureReason:failure,retryAt:facts.failure?.retryAt||null,attempts:facts.failure?.attempts??0,nextAction:'retry_prediction'});
 if(!facts.present)return dimensionState('prediction',{status:'missing',updatedAt:now,source:'prediction',nextAction:next});
 const stored=facts,profile=facts.profile;
 const aligned=fingerprintCurrent&&profile&&facts.currentFingerprintHash!=null&&stored.tasteProfileVersion===profile.version&&stored.tasteProfileHash===profile.profileHash&&stored.fingerprintHash===facts.currentFingerprintHash&&stored.fingerprintSchemaVersion===FINGERPRINT_SCHEMA_VERSION&&stored.predictionPromptVersion===PREDICTION_PROMPT_VERSION;
 if(!aligned)return dimensionState('prediction',{status:'stale',updatedAt:now,source:'prediction',sourceVersion:profile?.version??null,provenance:{profileVersion:stored.tasteProfileVersion??null,profileHash:stored.tasteProfileHash??null,fingerprintHash:stored.fingerprintHash??null,promptVersion:stored.predictionPromptVersion??null},nextAction:next});
 return dimensionState('prediction',{status:'current',updatedAt:now,source:'prediction',sourceVersion:profile.version,provenance:{profileHash:profile.profileHash,fingerprintHash:facts.currentFingerprintHash,promptVersion:PREDICTION_PROMPT_VERSION},nextAction:'leave'});
}
function filmView(facts){
 if(facts.decision?.status==='excluded_nonfilm')return null;
 const id=localFilmId(facts);if(!id)return null;
 const identity=identityState(facts);if(!identity)return null;
 const conflicts=uniqueIds(facts.conflictingTmdbIds);
 const tmdbId=conflicts.length>1?null:facts.tmdbId??null;
 const now=facts.now??null;
 const localization=titleLocalization({...facts.title,tmdbId,now});
 const fingerprint=fingerprintState({...facts.fingerprint,now});
 const aliases=mergeAliases([],titleAliases(facts,localization));
 return {contractVersion:DOMAIN_CONTRACT_VERSION,id,canonicalIdentity:tmdbId?'tmdb:'+tmdbId:null,externalIds:externalIds(facts),aliases,originalTitle:facts.title?.original||null,epgTitle:facts.title?.epgTitle||null,localizationConflicts:[],identity,metadata:metadataState({...facts.metadata,now}),localization,fingerprint,prediction:predictionState({...facts.prediction,profile:facts.profile,currentFingerprintHash:facts.currentFingerprintHash,fingerprint,now})};
}
function titleAliases(facts,localization){
 const seeds=[];
 const push=(value,source)=>{if(value&&value!==localization.value)seeds.push({kind:'title',value,provenance:{source}});};
 push(facts.title?.original,'letterboxd');
 push(facts.title?.epgTitle,'epg');
 return seeds;
}
function personView(facts){
 const id=localPersonId(facts.roleId);if(!id)return null;
 const now=facts.now??null,localization=personLocalization({...facts,now});
 const seeds=[];
 if(facts.original)seeds.push({kind:'name',value:facts.original,provenance:{source:'letterboxd'}});
 for(const value of facts.dictionary?.aliases||[])if(value&&value!==localization.value)seeds.push({kind:'name',value,provenance:{source:'dictionary'}});
 if(facts.cacheName&&facts.cacheName!==localization.value)seeds.push({kind:'name',value:facts.cacheName,provenance:{source:'wikidata'}});
 return {contractVersion:DOMAIN_CONTRACT_VERSION,id,roleId:facts.roleId,externalIds:[{scheme:'letterboxd-role',value:facts.roleId,conflicting:false,provenance:{source:'letterboxd'}}],original:facts.original||null,aliases:mergeAliases([],seeds),localizationConflicts:[],identity:dimensionState('identity',{status:'resolved',updatedAt:now,source:'letterboxd',sourceVersion:facts.roleId,provenance:{scope:'role',dedupe:'deferred'},nextAction:'stop'}),localization};
}
function preferredTitle(film){return film?.localization?.value||film?.originalTitle||film?.epgTitle||null;}
function displayReady(film){
 if(!film||film.identity?.status==='rejected')return false;
 const showable=film.identity?.status==='resolved'||(film.externalIds||[]).some(item=>item.scheme==='letterboxd');
 return showable&&!!preferredTitle(film);
}
function catalogReady(film){
 if(!film||film.identity?.status==='rejected')return false;
 const stable=(film.externalIds||[]).some(item=>item.scheme==='letterboxd'||(item.scheme==='tmdb'&&!item.conflicting));
 return stable&&(film.metadata?.status==='fresh'||film.metadata?.status==='partial');
}
function predictionReady(film){return !!film&&film.fingerprint?.status==='current'&&film.prediction?.status==='current';}
function applyAutomaticLocalization(entity,incoming,at,kind='title'){
 const current=entity.localization;
 if(current.status==='reviewed'&&incoming.status!=='reviewed')return {...entity,localization:current,aliases:mergeAliases(entity.aliases,[{kind,value:incoming.value,provenance:incoming.provenance??null}]),localizationConflicts:[...(entity.localizationConflicts||[]),{value:incoming.value,source:incoming.source||null,provenance:incoming.provenance??null,at:stamp(at)}]};
 const moved=transition(current,incoming.status,{updatedAt:at,source:incoming.source||null,sourceVersion:incoming.sourceVersion||incoming.status,provenance:incoming.provenance??null,value:incoming.value,nextAction:incoming.status==='reviewed'?'keep_reviewed':'keep_provisional'});
 if(!moved.ok)return entity;
 const previous=current.value&&current.value!==incoming.value?[{kind,value:current.value,provenance:current.provenance}]:[];
 return {...entity,localization:moved.state,aliases:mergeAliases(entity.aliases,previous)};
}
function invalidatePredictionForProfile(film,profile,at){
 if(film.prediction.status==='missing')return film;
 const moved=transition(film.prediction,'stale',{updatedAt:at,source:'taste_profile',sourceVersion:profile?.version??null,provenance:{reason:'profile_changed',profileHash:profile?.profileHash??null},failureReason:null,lastError:null,nextAction:film.fingerprint.status==='current'?'prediction_only':'fingerprint_and_prediction'});
 if(!moved.ok)throw new Error('profile change cannot leave prediction '+film.prediction.status);
 return {...film,prediction:moved.state,fingerprint:film.fingerprint};
}
function observeMetadata(film,observation){return {...film,metadata:metadataState(observation),fingerprint:film.fingerprint,prediction:film.prediction};}
function availabilityProjection({shows,epgLastAiring,now}){
 const starts=(shows||[]).map(show=>Number(show.start)).filter(Number.isFinite);
 const availableUntil=starts.length?new Date(Math.max(...starts)+AVAILABLE_MS).toISOString():null;
 const from=clock(now)-HOT_PAST_MS,until=clock(now)+HOT_FUTURE_MS,open=start=>start>=from&&start<until;
 return {availableUntil,hot:starts.length?starts.some(open):Number.isFinite(epgLastAiring)&&open(epgLastAiring)};
}
function attachAvailability(film,observation){return {...film,availability:availabilityProjection(observation),fingerprint:film.fingerprint,prediction:film.prediction};}
