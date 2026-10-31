// Reviewed preferred title for one Film, AIR-125.
// Pure validation and transition rules for the owner's manual title review. It is loaded
// beside film-person.js and reuses its guards (applyReviewedLocalization, mergeAliases,
// preferredTitle, stamp). No HTTP and no storage access here. The Worker bundle loads it
// so the admin title route can call it; that route persists what these functions return.
const TITLE_REVIEW_CONTRACT_VERSION=1;
const TITLE_REVIEW_MODES=Object.freeze(['alias','manual']);
const TITLE_REVIEW_AUTHORITY='owner';
const TITLE_REVIEW_MAX_LENGTH=200;
const TITLE_REVIEW_BASIS_MAX_LENGTH=500;
// Command fields that would change identity rather than the title. A title review never touches them.
const TITLE_REVIEW_IDENTITY_FIELDS=Object.freeze(['id','canonicalIdentity','externalIds','identity','tmdbId','letterboxdId','redirects']);

function reviewText(value){return typeof value==='string'?value.replace(/\s+/g,' ').trim():'';}
function reviewBasis(value){return typeof value==='string'?value.trim()||null:null;}
function validReviewTitle(text){return !!text&&text.length<=TITLE_REVIEW_MAX_LENGTH&&!/[\u0000-\u001f\u007f]/.test(text);}
// Deterministic serialization for the version token: object keys sorted, undefined read as null.
function reviewStableJson(value){
 if(Array.isArray(value))return '['+value.map(reviewStableJson).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+reviewStableJson(value[key])).join(',')+'}';
 return JSON.stringify(value??null);
}
// cyrb53: a small, dependency-free 53-bit string hash. The version token only has to change
// whenever the review state the owner looks at changes; it is not a secret.
function reviewHash(text,seed=0){
 let h1=0xdeadbeef^seed,h2=0x41c6ce57^seed;
 for(let i=0;i<text.length;i++){const ch=text.charCodeAt(i);h1=Math.imul(h1^ch,2654435761);h2=Math.imul(h2^ch,1597334677);}
 h1=Math.imul(h1^(h1>>>16),2246822507);h1^=Math.imul(h2^(h2>>>13),3266489909);
 h2=Math.imul(h2^(h2>>>16),2246822507);h2^=Math.imul(h1^(h1>>>13),3266489909);
 return (4294967296*(2097151&h2)+(h1>>>0)).toString(16).padStart(14,'0');
}
function reviewTitleAliases(film){return (film?.aliases||[]).filter(alias=>alias?.value&&(alias.kind||'title')==='title');}
// An audit entry as the version token sees it: the whole entry except its own `version.after`,
// which is the token of the state that contains the entry and so cannot be part of that token.
function reviewAuditBody(review){
 if(!review||typeof review!=='object')return review??null;
 const {version,...rest}=review;
 return {...rest,version:{before:version?.before??null}};
}
// Compare-and-set token over everything titleReviewState shows: the whole localization envelope
// including its provenance, the title aliases with their provenance, the selectable option texts,
// the earlier audit entries in full (minus each entry's own `version.after`) and the held conflicts.
// Metadata, fingerprint, prediction and identity are not part of it. A storage adapter can map it
// onto its own row version or etag; offline it is the only version there is.
function titleReviewVersion(film){
 const body={
  localization:film?.localization??null,
  aliases:reviewTitleAliases(film).slice().sort((a,b)=>a.value<b.value?-1:a.value>b.value?1:0),
  options:titleReviewOptions(film).map(option=>option.value).sort(),
  reviews:(film?.titleReviews||[]).map(reviewAuditBody),
  conflicts:film?.localizationConflicts??[],
 };
 return 'title-review:1:'+reviewHash(reviewStableJson(body));
}
// What the owner can select in alias mode: the current preferred value, title aliases, the
// original and the EPG title. The order is the display order; duplicates collapse to the first.
function titleReviewOptions(film){
 const out=[],seen=new Set();
 const push=(value,origin,provenance)=>{if(!value||seen.has(value))return;seen.add(value);out.push({value,origin,provenance:provenance??null,preferred:value===(film?.localization?.value??null)});};
 push(film?.localization?.value,'preferred',film?.localization?.provenance);
 for(const alias of film?.aliases||[])if(alias?.value&&(alias.kind||'title')==='title')push(alias.value,'alias',alias.provenance);
 push(film?.originalTitle,'original',{source:'letterboxd'});
 push(film?.epgTitle,'epg',{source:'epg'});
 return out;
}
// Read model for the review screen. Nothing here is a stored status; it is derived from the Film.
function titleReviewState(film){
 const localization=film?.localization||{};
 const reviewed=localization.status==='reviewed';
 return {
  contractVersion:TITLE_REVIEW_CONTRACT_VERSION,
  filmId:film?.id??null,
  canonicalIdentity:film?.canonicalIdentity??null,
  version:titleReviewVersion(film),
  preferred:{value:preferredTitle(film),status:localization.status??'missing',source:localization.source??null,authority:localization.provenance?.authority??null,reviewedAt:reviewed?localization.updatedAt??null:null,basis:localization.provenance?.basis??null},
  options:titleReviewOptions(film),
  reviews:[...(film?.titleReviews||[])],
  heldConflicts:(film?.localizationConflicts||[]).length,
 };
}
// Admin read-model projection of a Film after a review: the AIR-123 record shape, where
// `preferred` is the localized value or null and never the original title.
function titleReviewProjection(film){return {...film,preferred:film?.localization?.value||null};}
function titleReviewFailure(reason,extra={}){return {ok:false,reason,...extra};}
// Shape checks: the command on its own against the Film's identity. These hold for a replay as
// well as for a new review, so applyTitleReview runs them before it looks for an earlier requestId.
function validateTitleReviewShape(film,command){
 if(!film?.id)return titleReviewFailure('missing_film');
 if(!command||typeof command!=='object'||Array.isArray(command))return titleReviewFailure('invalid_command');
 if(command.filmId!==film.id)return titleReviewFailure('film_mismatch',{expected:film.id,received:command.filmId??null});
 if(typeof command.requestId!=='string'||!command.requestId.trim())return titleReviewFailure('missing_request_id');
 for(const field of TITLE_REVIEW_IDENTITY_FIELDS)if(Object.prototype.hasOwnProperty.call(command,field))return titleReviewFailure('identity_change_forbidden',{field});
 if(!TITLE_REVIEW_MODES.includes(command.mode))return titleReviewFailure('invalid_mode',{modes:[...TITLE_REVIEW_MODES]});
 const value=reviewText(command.value);
 if(!validReviewTitle(value))return titleReviewFailure('invalid_title',{maxLength:TITLE_REVIEW_MAX_LENGTH});
 if(command.basis!=null&&(typeof command.basis!=='string'||command.basis.length>TITLE_REVIEW_BASIS_MAX_LENGTH))return titleReviewFailure('invalid_basis',{maxLength:TITLE_REVIEW_BASIS_MAX_LENGTH});
 return {ok:true,value,basis:reviewBasis(command.basis)};
}
// Validates one command against the current Film without changing anything: the shape checks,
// then the state checks (rejected identity, compare-and-set token, alias membership).
function validateTitleReview(film,command){
 const shape=validateTitleReviewShape(film,command);
 if(!shape.ok)return shape;
 const {value,basis}=shape;
 if(film.identity?.status==='rejected')return titleReviewFailure('rejected_identity');
 const version=titleReviewVersion(film);
 if(command.expectedVersion!==version)return titleReviewFailure('version_conflict',{expected:version,received:command.expectedVersion??null});
 const options=titleReviewOptions(film);
 const selected=options.find(option=>option.value===value)||null;
 if(command.mode==='alias'&&!selected)return titleReviewFailure('unknown_alias',{options:options.map(option=>option.value)});
 return {ok:true,value,basis,version,selected};
}
// A replay is the same committed request sent again: same Film, mode, normalized value and
// normalized basis under the same requestId. Anything else under that requestId is a reuse.
function sameTitleReview(review,film,command,shape){
 return review.filmId===film.id&&review.mode===command.mode&&review.to?.value===shape.value&&(review.basis??null)===shape.basis;
}
// Applies one review. The result carries the next Film, the audit entry and the new version.
// A repeated requestId with the same payload replays the earlier outcome without a second change,
// even with a stale or missing expectedVersion: the state checks guard new changes, not retries.
function applyTitleReview(film,command,at){
 const shape=validateTitleReviewShape(film,command);
 if(!shape.ok)return shape;
 const replay=(film.titleReviews||[]).find(review=>review.requestId===command.requestId);
 if(replay){
  if(sameTitleReview(replay,film,command,shape))return {ok:true,idempotent:true,changed:false,film,review:replay,version:titleReviewVersion(film)};
  return titleReviewFailure('request_id_reused',{review:replay});
 }
 const checked=validateTitleReview(film,command);
 if(!checked.ok)return checked;
 const {value,basis,selected}=checked;
 if(film.localization?.status==='reviewed'&&film.localization.value===value)return {ok:true,idempotent:false,changed:false,film,review:null,version:checked.version};
 // selectedFrom names where the picked text came from: an alias reports its own source (epg, letterboxd, wikidata...).
 const selectedFrom=selected?(selected.origin==='alias'?selected.provenance?.source||'alias':selected.origin):null;
 const provenance={source:TITLE_REVIEW_AUTHORITY,authority:TITLE_REVIEW_AUTHORITY,mode:command.mode,basis,requestId:command.requestId,selectedFrom};
 const moved=applyReviewedLocalization(film,{value,authority:TITLE_REVIEW_AUTHORITY,source:TITLE_REVIEW_AUTHORITY,provenance},at,'title');
 if(moved.localization===film.localization)return titleReviewFailure('illegal_transition',{from:film.localization?.status??null});
 const review={contractVersion:TITLE_REVIEW_CONTRACT_VERSION,requestId:command.requestId,filmId:film.id,at:stamp(at),mode:command.mode,authority:TITLE_REVIEW_AUTHORITY,basis,selectedFrom:provenance.selectedFrom,from:{value:film.localization?.value??null,status:film.localization?.status??'missing',source:film.localization?.source??null},to:{value,status:'reviewed'},version:{before:checked.version,after:null}};
 const next={...moved,aliases:mergeAliases(moved.aliases.filter(alias=>!((alias.kind||'title')==='title'&&alias.value===value)),[]),titleReviews:[...(film.titleReviews||[]),review]};
 review.version.after=titleReviewVersion(next);
 return {ok:true,idempotent:false,changed:true,film:next,review,version:review.version.after};
}
