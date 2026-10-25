// Reviewed preferred title for one Film, AIR-125.
// Pure validation and transition rules for the owner's manual title review. It is loaded
// beside film-person.js and reuses its guards (applyReviewedLocalization, mergeAliases,
// preferredTitle, stamp). No HTTP and no storage access here, and this file is not in the Worker bundle:
// a separately approved writer (AIR-53) persists what these functions return.
const TITLE_REVIEW_CONTRACT_VERSION=1;
const TITLE_REVIEW_MODES=Object.freeze(['alias','manual']);
const TITLE_REVIEW_AUTHORITY='owner';
const TITLE_REVIEW_MAX_LENGTH=200;
const TITLE_REVIEW_BASIS_MAX_LENGTH=500;
// Command fields that would change identity rather than the title. A title review never touches them.
const TITLE_REVIEW_IDENTITY_FIELDS=Object.freeze(['id','canonicalIdentity','externalIds','identity','tmdbId','letterboxdId','redirects']);

function reviewText(value){return typeof value==='string'?value.replace(/\s+/g,' ').trim():'';}
function validReviewTitle(text){return !!text&&text.length<=TITLE_REVIEW_MAX_LENGTH&&!/[\u0000-\u001f\u007f]/.test(text);}
// cyrb53: a small, dependency-free 53-bit string hash. The version token only has to change
// whenever the reviewed title, its envelope or the title aliases change; it is not a secret.
function reviewHash(text,seed=0){
 let h1=0xdeadbeef^seed,h2=0x41c6ce57^seed;
 for(let i=0;i<text.length;i++){const ch=text.charCodeAt(i);h1=Math.imul(h1^ch,2654435761);h2=Math.imul(h2^ch,1597334677);}
 h1=Math.imul(h1^(h1>>>16),2246822507);h1^=Math.imul(h2^(h2>>>13),3266489909);
 h2=Math.imul(h2^(h2>>>16),2246822507);h2^=Math.imul(h1^(h1>>>13),3266489909);
 return (4294967296*(2097151&h2)+(h1>>>0)).toString(16).padStart(14,'0');
}
function titleAliasValues(film){return (film?.aliases||[]).filter(alias=>alias?.value&&(alias.kind||'title')==='title').map(alias=>alias.value);}
// Compare-and-set token derived from the state a title review may change. A storage adapter
// can map it onto its own row version or etag; offline it is the only version there is.
function titleReviewVersion(film){
 const localization=film?.localization||{};
 const body={status:localization.status??null,value:localization.value??null,updatedAt:localization.updatedAt??null,source:localization.source??null,sourceVersion:localization.sourceVersion??null,authority:localization.provenance?.authority??null,aliases:[...titleAliasValues(film)].sort(),reviews:(film?.titleReviews||[]).map(review=>review.requestId)};
 return 'title-review:1:'+reviewHash(JSON.stringify(body));
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
// Validates one command against the current Film without changing anything.
function validateTitleReview(film,command){
 if(!film?.id)return titleReviewFailure('missing_film');
 if(!command||typeof command!=='object'||Array.isArray(command))return titleReviewFailure('invalid_command');
 if(command.filmId!==film.id)return titleReviewFailure('film_mismatch',{expected:film.id,received:command.filmId??null});
 if(typeof command.requestId!=='string'||!command.requestId.trim())return titleReviewFailure('missing_request_id');
 for(const field of TITLE_REVIEW_IDENTITY_FIELDS)if(Object.prototype.hasOwnProperty.call(command,field))return titleReviewFailure('identity_change_forbidden',{field});
 if(!TITLE_REVIEW_MODES.includes(command.mode))return titleReviewFailure('invalid_mode',{modes:[...TITLE_REVIEW_MODES]});
 if(film.identity?.status==='rejected')return titleReviewFailure('rejected_identity');
 const value=reviewText(command.value);
 if(!validReviewTitle(value))return titleReviewFailure('invalid_title',{maxLength:TITLE_REVIEW_MAX_LENGTH});
 if(command.basis!=null&&(typeof command.basis!=='string'||command.basis.length>TITLE_REVIEW_BASIS_MAX_LENGTH))return titleReviewFailure('invalid_basis',{maxLength:TITLE_REVIEW_BASIS_MAX_LENGTH});
 const version=titleReviewVersion(film);
 if(command.expectedVersion!==version)return titleReviewFailure('version_conflict',{expected:version,received:command.expectedVersion??null});
 const options=titleReviewOptions(film);
 const selected=options.find(option=>option.value===value)||null;
 if(command.mode==='alias'&&!selected)return titleReviewFailure('unknown_alias',{options:options.map(option=>option.value)});
 return {ok:true,value,version,selected};
}
// Applies one review. The result carries the next Film, the audit entry and the new version.
// A repeated requestId with the same payload replays the earlier outcome without a second change.
function applyTitleReview(film,command,at){
 const replay=(film?.titleReviews||[]).find(review=>review.requestId===command?.requestId);
 if(replay){
  if(replay.mode===command.mode&&replay.to?.value===reviewText(command.value))return {ok:true,idempotent:true,changed:false,film,review:replay,version:titleReviewVersion(film)};
  return titleReviewFailure('request_id_reused',{review:replay});
 }
 const checked=validateTitleReview(film,command);
 if(!checked.ok)return checked;
 const {value,selected}=checked;
 if(film.localization?.status==='reviewed'&&film.localization.value===value)return {ok:true,idempotent:false,changed:false,film,review:null,version:checked.version};
 const basis=command.basis==null?null:command.basis.trim()||null;
 // selectedFrom names where the picked text came from: an alias reports its own source (epg, letterboxd, wikidata...).
 const selectedFrom=selected?(selected.origin==='alias'?selected.provenance?.source||'alias':selected.origin):null;
 const provenance={source:TITLE_REVIEW_AUTHORITY,authority:TITLE_REVIEW_AUTHORITY,mode:command.mode,basis,requestId:command.requestId,selectedFrom};
 const moved=applyReviewedLocalization(film,{value,authority:TITLE_REVIEW_AUTHORITY,source:TITLE_REVIEW_AUTHORITY,provenance},at,'title');
 if(moved.localization===film.localization)return titleReviewFailure('illegal_transition',{from:film.localization?.status??null});
 const review={contractVersion:TITLE_REVIEW_CONTRACT_VERSION,requestId:command.requestId,at:stamp(at),mode:command.mode,authority:TITLE_REVIEW_AUTHORITY,basis,selectedFrom:provenance.selectedFrom,from:{value:film.localization?.value??null,status:film.localization?.status??'missing',source:film.localization?.source??null},to:{value,status:'reviewed'},version:{before:checked.version,after:null}};
 const next={...moved,aliases:mergeAliases(moved.aliases.filter(alias=>!((alias.kind||'title')==='title'&&alias.value===value)),[]),titleReviews:[...(film.titleReviews||[]),review]};
 review.version.after=titleReviewVersion(next);
 return {ok:true,idempotent:false,changed:true,film:next,review,version:review.version.after};
}
