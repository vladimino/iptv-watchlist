// Prediction compatibility across taste-profile versions (ADR-0031 sections 2, 3, 6). One pure rule for every consumer:
// is a stored prediction current, compatible (carried forward through published, approved change impacts) or stale.
// Builds on src/domain/profile-impact.js (selector and approval rules). No I/O: the fingerprint vocabulary and a
// synchronous SHA-256 of the declaration text are passed in by the caller.
const PREDICTION_COMPATIBILITY_VERSION=1;
const PREDICTION_COMPATIBILITY_MODES=['strict','selective'];
// Stored genre names (Russian TMDB names, the Letterboxd source labels, English TMDB names) -> canonical genre, case-folded.
const PROFILE_GENRE_ALIASES={
 'боевик':'action','приключения':'adventure','мультфильм':'animation','комедия':'comedy','криминал':'crime','документальный':'documentary','драма':'drama',
 'семейный':'family','фэнтези':'fantasy','история':'history','исторический':'history','ужасы':'horror','музыка':'music','музыкальный':'music','детектив':'mystery',
 'мелодрама':'romance','фантастика':'science_fiction','триллер':'thriller','телевизионный фильм':'tv_movie','телефильм':'tv_movie','военный':'war','вестерн':'western',
 'action':'action','adventure':'adventure','animation':'animation','comedy':'comedy','crime':'crime','documentary':'documentary','drama':'drama','family':'family',
 'fantasy':'fantasy','history':'history','horror':'horror','music':'music','mystery':'mystery','romance':'romance','science fiction':'science_fiction',
 'thriller':'thriller','tv movie':'tv_movie','war':'war','western':'western'
};
// The genre a genre-specific execution dimension applies to; its absence proves nothing inside that genre.
const PROFILE_GENRE_DOMAINS={
 comedy_stupidity_for_gags:['comedy'],comedy_gross_out:['comedy'],horror_rule_consistency:['horror'],horror_threat_causality:['horror'],
 scifi_plot_driven_concept:['science_fiction'],adventure_discovery_strength:['adventure'],action_readability:['action'],hero_vulnerability:['action']
};
// The features a selector is evaluated on: the fingerprint the prediction was made with and the film's current genres.
function predictionImpactFeatures(fingerprint,genres){
 return {fingerprintHash:fingerprint?.fingerprintHash??null,plotMechanics:Array.isArray(fingerprint?.plotMechanics)?[...fingerprint.plotMechanics]:undefined,
  execution:fingerprint?.execution&&typeof fingerprint.execution==='object'&&!Array.isArray(fingerprint.execution)?{...fingerprint.execution}:undefined,genres:Array.isArray(genres)?[...genres]:[]};
}
// Canonical genres of a film, or null when any stored name is not a known alias (or there is none): unknown, never "no genre".
function predictionCanonicalGenres(genres){
 if(!Array.isArray(genres)||!genres.length)return null;
 const mapped=genres.map(name=>typeof name==='string'?PROFILE_GENRE_ALIASES[name.trim().toLocaleLowerCase('ru')]:undefined);
 return mapped.every(Boolean)?[...new Set(mapped)]:null;
}
// 'reached' | 'not_reached' | 'unknown' for one valid selector. A stored value outside the fingerprint vocabulary is
// malformed and counts as unknown, never as "not reached".
function predictionSelectorReach(selector,features,vocabulary){
 const general=vocabulary.general||[];
 if(selector.kind==='mechanic'){
  if(!Array.isArray(features.plotMechanics)||!features.plotMechanics.every(value=>vocabulary.mechanics.includes(value)))return 'unknown';
  return features.plotMechanics.some(value=>selector.values.includes(value))?'reached':'not_reached';
 }
 if(selector.kind==='genre'){const genres=predictionCanonicalGenres(features.genres);if(!genres)return 'unknown';return genres.some(genre=>selector.values.includes(genre))?'reached':'not_reached';}
 if(!features.execution||typeof features.execution!=='object'||Array.isArray(features.execution))return 'unknown';
 const value=features.execution[selector.dimension];
 if(value===undefined){
  if(general.includes(selector.dimension))return 'unknown';
  const genres=predictionCanonicalGenres(features.genres),domain=PROFILE_GENRE_DOMAINS[selector.dimension]||[];
  return !genres||!domain.length||genres.some(genre=>domain.includes(genre))?'unknown':'not_reached';
 }
 if(value==='unknown'||!vocabulary.execution[selector.dimension]?.includes(value))return 'unknown';
 if(value==='not_applicable')return 'not_reached';
 return selector.values.includes(value)?'reached':'not_reached';
}
// A lineage link is usable only with a well-formed impact; a selective one also needs an owner approval bound to its declaration.
function predictionLinkUsable(link,vocabulary,digest){
 const impact=link?.changeImpact;
 if(!impact||typeof impact!=='object'||impact.impactSchemaVersion!==PROFILE_IMPACT_SCHEMA_VERSION||!PROFILE_IMPACT_SCOPES.includes(impact.scope)||!Array.isArray(impact.selectors))return false;
 if(impact.scope!=='selective')return impact.selectors.length===0;
 if(!impact.selectors.length||!impact.selectors.every(selector=>profileSelectorValid(selector,vocabulary))||!profileApprovalComplete(impact.approval))return false;
 const text=profileDeclarationText(impact,{version:link.version,profileHash:link.profileHash});
 return !!text&&typeof digest==='function'&&digest(text)===impact.approval.declarationSha256;
}
// predictionCompatibility(prediction, fingerprint, features, profile, mode, options) -> {outcome, reason, originalProfile,
// evaluatedAgainst, links}. `profile` is current.json ({version, profileHash, lineage}); `features` comes from
// predictionImpactFeatures; options: {vocabulary: {mechanics, execution, general}, digest(text) -> SHA-256 hex,
// fingerprintSchemaVersion, predictionPromptVersion}. The first failing check decides, in the order of ADR-0031 section 3.
function predictionCompatibility(prediction,fingerprint,features,profile,mode,options){
 const originalProfile={version:prediction?.tasteProfileVersion??null,profileHash:prediction?.tasteProfileHash??null};
 const evaluatedAgainst={version:profile?.version??null,profileHash:profile?.profileHash??null};
 const result=(outcome,reason,links=0)=>({outcome,reason,originalProfile,evaluatedAgainst,links});
 if(!prediction||!profile)return result('stale',!profile?'profile_outside_lineage':'profile_provenance_mismatch');
 if(!fingerprint||fingerprint.fingerprintSchemaVersion!==options.fingerprintSchemaVersion||fingerprint.invalidatedAt)return result('stale','fingerprint_not_current');
 if(prediction.fingerprintHash!==fingerprint.fingerprintHash||prediction.fingerprintSchemaVersion!==options.fingerprintSchemaVersion)return result('stale','fingerprint_changed');
 if(prediction.predictionPromptVersion!==options.predictionPromptVersion)return result('stale','prompt_changed');
 if(prediction.tasteProfileVersion===profile.version)return prediction.tasteProfileHash===profile.profileHash?result('current','exact'):result('stale','profile_provenance_mismatch');
 if(mode!=='selective')return result('stale','profile_changed');
 if(!Number.isInteger(prediction.tasteProfileVersion)||!Number.isInteger(profile.version))return result('stale','profile_provenance_mismatch');
 if(prediction.tasteProfileVersion>profile.version)return result('stale','profile_ahead');
 const lineage=Array.isArray(profile.lineage)?profile.lineage:[],start=lineage.findIndex(link=>link?.version===prediction.tasteProfileVersion);
 if(start<0)return result('stale','profile_outside_lineage');
 if(lineage[start].profileHash!==prediction.tasteProfileHash)return result('stale','profile_provenance_mismatch');
 const links=lineage.length-1-start,last=lineage.at(-1);
 if(last?.version!==profile.version||last?.profileHash!==profile.profileHash)return result('stale','profile_chain_broken',links);
 if(prediction.tasteProfileHash===profile.profileHash)return result('compatible','content_identical',links);
 const vocabulary=options.vocabulary;
 // Features count only when they carry the hash of the very fingerprint the prediction was made with.
 const known=!!features&&typeof features.fingerprintHash==='string'&&features.fingerprintHash.length>0&&features.fingerprintHash===fingerprint.fingerprintHash;
 for(let i=start+1;i<lineage.length;i++){
  const link=lineage[i],previous=lineage[i-1],impact=link?.changeImpact;
  if(!(link?.version>previous.version))return result('stale','profile_chain_broken',links);
  if(impact&&typeof impact==='object'&&(impact.from?.version!==previous.version||impact.from?.profileHash!==previous.profileHash))return result('stale','profile_chain_broken',links);
  if(!predictionLinkUsable(link,vocabulary,options.digest))return result('stale','profile_impact_unknown',links);
  if(impact.scope==='global')return result('stale','profile_global_change',links);
  if(impact.scope==='identity'){if(link.profileHash!==previous.profileHash)return result('stale','profile_impact_unknown',links);continue;}
  if(!known)return result('stale','film_features_unknown',links);
  const reach=impact.selectors.map(selector=>predictionSelectorReach(selector,features,vocabulary));
  if(reach.includes('reached'))return result('stale','profile_impacted',links);
  if(reach.includes('unknown'))return result('stale','film_features_unknown',links);
 }
 return result('compatible','profile_unaffected',links);
}
const predictionCompatibilityFresh=compatibility=>compatibility?.outcome==='current'||compatibility?.outcome==='compatible';
