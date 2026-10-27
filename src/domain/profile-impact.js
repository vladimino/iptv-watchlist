// Taste-profile change impact (ADR-0031 sections 1, 4, 4a). Every published version after the first declares what its
// edit can reach: identity, selective (typed selectors, owner approval bound to the exact declaration) or global.
// Pure functions only: the fingerprint vocabulary and the SHA-256 of the declaration are passed in by the caller.
const PROFILE_IMPACT_SCHEMA_VERSION=1;
const PROFILE_LINEAGE_LIMIT=32;
const PROFILE_IMPACT_SCOPES=['identity','selective','global'];
const PROFILE_SELECTOR_KINDS=['mechanic','execution','genre'];
const PROFILE_GENRES=['action','adventure','animation','comedy','crime','documentary','drama','family','fantasy','history','horror','music','mystery','romance','science_fiction','thriller','tv_movie','war','western'];
// Changed field -> selectors that may cover it. A field without kinds is global-only.
const PROFILE_FIELD_RULES={
 ratingScale:{},calibration:{},anchorFilms:{},
 genrePreferences:{kinds:['genre']},
 comedyPreferences:{kinds:['genre','execution'],dimensions:['comedy_stupidity_for_gags','comedy_gross_out'],genreFloor:['comedy']},
 horrorPreferences:{kinds:['genre','execution'],dimensions:['horror_rule_consistency','horror_threat_causality'],genreFloor:['horror']},
 scifiAdventurePreferences:{kinds:['genre','execution'],dimensions:['scifi_plot_driven_concept','adventure_discovery_strength'],genreFloor:['science_fiction','adventure']},
 actionPreferences:{kinds:['genre','execution'],dimensions:['action_readability','hero_vulnerability'],genreFloor:['action']},
 characterLogic:{kinds:['execution'],dimensions:['decision_logic','protagonist_competence','opposition_competence','problem_solving']},
 pace:{kinds:['execution'],dimensions:['pace','plot_engine']},
 payoffEnding:{kinds:['execution'],dimensions:['payoff','ending_quality']},
 positiveSignals:{kinds:['mechanic','execution','genre']},
 negativeSignals:{kinds:['mechanic','execution','genre']},
 hardSkips:{kinds:['mechanic','execution','genre']}
};
const PROFILE_IMPACT_KEYS=['impactSchemaVersion','from','scope','changedFields','selectors','rationale','approval'];
const PROFILE_APPROVAL_KEYS=['approvedBy','approvedAt','reviewRef','declarationSha256'];
function profileImpactCanonical(value){
 if(Array.isArray(value))return value.map(profileImpactCanonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,profileImpactCanonical(value[key])]));
 return value;
}
const profileImpactPlain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const profileImpactRef=value=>profileImpactPlain(value)&&Number.isInteger(value.version)&&value.version>=1&&typeof value.profileHash==='string'&&value.profileHash.length>0&&Object.keys(value).length===2;
// Top-level profile fields whose canonical value differs, in field-rule order.
function profileChangedFields(previous,next){
 const text=value=>JSON.stringify(profileImpactCanonical(value===undefined?null:value));
 return Object.keys(PROFILE_FIELD_RULES).filter(field=>text(previous?.[field])!==text(next?.[field]));
}
// The text whose SHA-256 an owner approval carries: the transition, the scope and the exact selectors, keys sorted.
function profileDeclarationText(impact,to){
 if(!profileImpactPlain(impact)||!profileImpactRef(impact.from)||!profileImpactRef(to)||!Array.isArray(impact.changedFields)||!Array.isArray(impact.selectors))return null;
 return JSON.stringify(profileImpactCanonical([impact.from.version,impact.from.profileHash,to.version,to.profileHash,impact.scope,[...impact.changedFields].sort(),impact.selectors]));
}
function profileSelectorValid(selector,vocabulary){
 if(!profileImpactPlain(selector)||!PROFILE_SELECTOR_KINDS.includes(selector.kind))return false;
 const allowed=selector.kind==='execution'?['kind','dimension','values']:['kind','values'];
 if(Object.keys(selector).some(key=>!allowed.includes(key))||!Array.isArray(selector.values)||!selector.values.length||new Set(selector.values).size!==selector.values.length)return false;
 if(selector.kind==='mechanic')return selector.values.every(value=>vocabulary.mechanics.includes(value));
 if(selector.kind==='genre')return selector.values.every(value=>PROFILE_GENRES.includes(value));
 const levels=vocabulary.execution[selector.dimension];
 return Array.isArray(levels)&&selector.values.every(value=>typeof value==='string'&&levels.includes(value)&&value!=='unknown'&&value!=='not_applicable');
}
const profileCovers=(rule,selector)=>(rule.kinds||[]).includes(selector.kind)&&(selector.kind!=='execution'||!rule.dimensions||rule.dimensions.includes(selector.dimension));
function profileApprovalComplete(approval){
 return profileImpactPlain(approval)&&Object.keys(approval).every(key=>PROFILE_APPROVAL_KEYS.includes(key))&&approval.approvedBy==='owner'
  &&typeof approval.approvedAt==='string'&&Number.isFinite(Date.parse(approval.approvedAt))&&typeof approval.reviewRef==='string'&&approval.reviewRef.trim().length>0&&approval.reviewRef.length<=500
  &&typeof approval.declarationSha256==='string'&&/^[0-9a-f]{64}$/.test(approval.declarationSha256);
}
// Validates the impact of `next` over `previous` (both {version, profileHash, profile}). `declarationSha256` is the
// SHA-256 of profileDeclarationText(impact, next), computed by the caller. Returns {ok, code, changedFields}; the codes
// and their order are those of ADR-0031 section 4.
function validateProfileImpact({previous,next,impact,declarationSha256,vocabulary}){
 const changedFields=profileChangedFields(previous?.profile,next?.profile),fail=code=>({ok:false,code,changedFields});
 if(impact==null)return fail('impact_missing');
 if(!profileImpactPlain(impact)||impact.impactSchemaVersion!==PROFILE_IMPACT_SCHEMA_VERSION||Object.keys(impact).some(key=>!PROFILE_IMPACT_KEYS.includes(key))||impact.rationale!==undefined&&(typeof impact.rationale!=='string'||impact.rationale.length>2000))return fail('impact_schema_unknown');
 if(!profileImpactRef(impact.from)||impact.from.version!==previous.version||impact.from.profileHash!==previous.profileHash)return fail('from_mismatch');
 if(!PROFILE_IMPACT_SCOPES.includes(impact.scope))return fail('scope_unknown');
 if(!Array.isArray(impact.selectors))return fail('selector_invalid');
 if(impact.scope==='identity'&&(next.profileHash!==previous.profileHash||changedFields.length))return fail('identity_requires_same_hash');
 const declared=Array.isArray(impact.changedFields)&&impact.changedFields.every(field=>typeof field==='string')?[...new Set(impact.changedFields)].sort():null;
 if(!declared||declared.length!==impact.changedFields.length||declared.join()!==[...changedFields].sort().join())return fail('changed_fields_mismatch');
 if(impact.scope!=='selective'){if(impact.selectors.length)return fail('selector_invalid');return {ok:true,code:null,changedFields};}
 if(changedFields.some(field=>!PROFILE_FIELD_RULES[field].kinds))return fail('global_field_requires_global');
 if(!impact.selectors.length)return fail('selective_requires_selectors');
 if(impact.selectors.some(selector=>!profileImpactPlain(selector)||!PROFILE_SELECTOR_KINDS.includes(selector.kind)))return fail('selector_kind_unknown');
 if(impact.selectors.some(selector=>!profileSelectorValid(selector,vocabulary)))return fail('selector_invalid');
 for(const field of changedFields)if(!impact.selectors.some(selector=>profileCovers(PROFILE_FIELD_RULES[field],selector)))return fail('field_not_covered');
 for(const field of changedFields)for(const genre of PROFILE_FIELD_RULES[field].genreFloor||[])if(!impact.selectors.some(selector=>selector.kind==='genre'&&selector.values.includes(genre)))return fail('genre_floor_missing');
 if(!profileApprovalComplete(impact.approval))return fail('selective_requires_owner_approval');
 if(impact.approval.declarationSha256!==declarationSha256)return fail('approval_mismatch');
 return {ok:true,code:null,changedFields};
}
// The lineage current.json carries after publishing `record`: the immutable (version, profileHash, changeImpact) of the
// most recent versions, oldest first. A current record from before lineage starts it with its own link.
function profileLineage(current,record){
 const link=item=>({version:item.version,profileHash:item.profileHash,changeImpact:item.changeImpact??null});
 const earlier=current?(Array.isArray(current.lineage)&&current.lineage.length?current.lineage:[link(current)]):[];
 return [...earlier,link(record)].slice(-PROFILE_LINEAGE_LIMIT);
}
