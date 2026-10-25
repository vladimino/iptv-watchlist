// Reviewed preferred RU name for one Person, AIR-126.
// Pure validation and transition rules for the owner's manual name review. It is loaded beside
// film-person.js and reuses its guards (applyReviewedLocalization, applyAutomaticLocalization,
// mergeAliases, stamp). No HTTP and no storage access here, and this file is not in the Worker
// bundle: a separately approved writer (AIR-54) persists what these functions return.
// A Person id is role-specific (person:actor/<slug>, person:director/<slug>, …). This contract never
// mints, merges or replaces an id: the same human under another role stays another record, and the
// owner links such records explicitly through `roles`, which records the link on both sides.
const NAME_REVIEW_CONTRACT_VERSION=1;
const NAME_REVIEW_MODES=Object.freeze(['alias','manual']);
const NAME_REVIEW_AUTHORITY='owner';
const NAME_REVIEW_MAX_LENGTH=200;
const NAME_REVIEW_BASIS_MAX_LENGTH=500;
const NAME_REVIEW_LINK_REASON='owner_same_person';
// Command fields that would change identity rather than the name. A name review never touches them.
const NAME_REVIEW_IDENTITY_FIELDS=Object.freeze(['id','roleId','externalIds','identity','canonicalIdentity','tmdbId','redirects']);

function nameReviewText(value){return typeof value==='string'?value.replace(/\s+/g,' ').trim():'';}
function nameReviewBasis(value){return typeof value==='string'?value.trim()||null:null;}
function nameReviewValid(text){return !!text&&text.length<=NAME_REVIEW_MAX_LENGTH&&!/[\u0000-\u001f\u007f]/.test(text);}
// Same folding as the admin query library: Latin diacritics stripped, ё read as е, case folded,
// punctuation turned into spaces. Collisions are compared on folded text, never merged on it.
function nameReviewFold(value){
 return String(value??'').replace(/\p{Script=Latin}+/gu,chunk=>chunk.normalize('NFD').replace(/\p{M}+/gu,'')).replace(/ё/gi,'е').toLocaleLowerCase('ru').replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim();
}
// Deterministic serialization for the version token: object keys sorted, undefined read as null.
function nameReviewStableJson(value){
 if(Array.isArray(value))return '['+value.map(nameReviewStableJson).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+nameReviewStableJson(value[key])).join(',')+'}';
 return JSON.stringify(value??null);
}
// cyrb53: a small, dependency-free 53-bit string hash. The token is not a secret.
function nameReviewHash(text,seed=0){
 let h1=0xdeadbeef^seed,h2=0x41c6ce57^seed;
 for(let i=0;i<text.length;i++){const ch=text.charCodeAt(i);h1=Math.imul(h1^ch,2654435761);h2=Math.imul(h2^ch,1597334677);}
 h1=Math.imul(h1^(h1>>>16),2246822507);h1^=Math.imul(h2^(h2>>>13),3266489909);
 h2=Math.imul(h2^(h2>>>16),2246822507);h2^=Math.imul(h1^(h1>>>13),3266489909);
 return (4294967296*(2097151&h2)+(h1>>>0)).toString(16).padStart(14,'0');
}
function personNameAliases(person){return (person?.aliases||[]).filter(alias=>alias?.value&&alias.kind==='name');}
function nameReviewSortById(list){return list.slice().sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);}
// An audit entry as the version token sees it: the whole entry except its own `version.after`,
// which is the token of the state that contains the entry and so cannot be part of that token.
function nameReviewAuditBody(review){
 if(!review||typeof review!=='object')return review??null;
 const {version,...rest}=review;
 return {...rest,version:{before:version?.before??null}};
}
// What the owner can select in alias mode: the current preferred name, the name aliases and the
// original credit text. The order is the display order; duplicates collapse to the first.
function personNameOptions(person){
 const out=[],seen=new Set();
 const push=(value,origin,provenance)=>{if(!value||seen.has(value))return;seen.add(value);out.push({value,origin,provenance:provenance??null,preferred:value===(person?.localization?.value??null)});};
 push(person?.localization?.value,'preferred',person?.localization?.provenance);
 for(const alias of personNameAliases(person))push(alias.value,'alias',alias.provenance);
 push(person?.original,'original',{source:'letterboxd'});
 return out;
}
// Compare-and-set token over everything personNameState shows for this record: the whole
// localization envelope including its provenance, the name aliases with their provenance, the
// selectable option texts, the earlier audit entries in full (minus each entry's own
// `version.after`), the held conflicts and the role links. Other records, identity, external ids
// and the role id are not part of it: a linked role carries its own token. A storage adapter can
// map it onto a row version or etag; offline it is the only version there is.
function personNameVersion(person){
 const body={
  localization:person?.localization??null,
  aliases:personNameAliases(person).slice().sort((a,b)=>a.value<b.value?-1:a.value>b.value?1:0),
  options:personNameOptions(person).map(option=>option.value).sort(),
  reviews:(person?.nameReviews||[]).map(nameReviewAuditBody),
  conflicts:person?.localizationConflicts??[],
  roleLinks:nameReviewSortById(person?.roleLinks||[]),
 };
 return 'name-review:1:'+nameReviewHash(nameReviewStableJson(body));
}
// Records in `people` that look like the same human under another role id: the same folded
// original credit text, or the same folded preferred name. This is a read model for the owner,
// not a merge: nothing here changes an id, and `linked` only reports an earlier explicit link.
function personNameCollisions(person,people){
 if(!person?.id||!Array.isArray(people))return [];
 const original=nameReviewFold(person.original),preferred=nameReviewFold(person.localization?.value);
 const linked=new Set((person.roleLinks||[]).map(link=>link.id));
 const out=[];
 for(const other of people){
  if(!other||typeof other!=='object'||!other.id||other.id===person.id)continue;
  const otherOriginal=nameReviewFold(other.original),otherPreferred=nameReviewFold(other.localization?.value);
  const sameOriginal=!!original&&original===otherOriginal;
  const samePreferred=!!preferred&&preferred===otherPreferred;
  if(!sameOriginal&&!samePreferred)continue;
  out.push({id:other.id,roleId:other.roleId??null,original:other.original??null,preferred:other.localization?.value??null,status:other.localization?.status??'missing',authority:other.localization?.provenance?.authority??null,reason:sameOriginal?'same_original':'same_preferred',linked:linked.has(other.id),version:personNameVersion(other)});
 }
 return nameReviewSortById(out);
}
// Read model for the review screen. Nothing here is a stored status; it is derived from the Person
// and, when the caller passes the other loaded Person records, from them.
function personNameState(person,people=[]){
 const localization=person?.localization||{};
 const reviewed=localization.status==='reviewed';
 return {
  contractVersion:NAME_REVIEW_CONTRACT_VERSION,
  personId:person?.id??null,
  roleId:person?.roleId??null,
  original:person?.original??null,
  version:personNameVersion(person),
  preferred:{value:localization.value??null,status:localization.status??'missing',source:localization.source??null,authority:localization.provenance?.authority??null,reviewedAt:reviewed?localization.updatedAt??null:null,basis:localization.provenance?.basis??null},
  options:personNameOptions(person),
  reviews:[...(person?.nameReviews||[])],
  heldConflicts:(person?.localizationConflicts||[]).length,
  roleLinks:nameReviewSortById(person?.roleLinks||[]),
  collisions:personNameCollisions(person,people),
 };
}
// Admin read-model projection of a Person after a review: the AIR-123 record shape, where
// `preferred` is the localized value or null and never the original credit text.
function personNameProjection(person){return {...person,preferred:person?.localization?.value||null};}
function nameReviewFailure(reason,extra={}){return {ok:false,reason,...extra};}
function nameReviewRoles(command){
 if(command.roles==null)return {ok:true,roles:[]};
 if(!Array.isArray(command.roles))return nameReviewFailure('invalid_roles');
 const roles=[],seen=new Set();
 for(const role of command.roles){
  const id=typeof role==='string'?role:role&&typeof role==='object'?role.id:null;
  if(typeof id!=='string'||!id||seen.has(id))return nameReviewFailure('invalid_roles',{role:id??null});
  seen.add(id);
  roles.push({id,expectedVersion:typeof role==='object'&&role!==null?role.expectedVersion:undefined});
 }
 return {ok:true,roles};
}
// Shape checks: the command on its own against the Person's identity. These hold for a replay as
// well as for a new review, so applyPersonNameReview runs them before it looks for an earlier requestId.
function validatePersonNameReviewShape(person,command){
 if(!person?.id)return nameReviewFailure('missing_person');
 if(!command||typeof command!=='object'||Array.isArray(command))return nameReviewFailure('invalid_command');
 if(command.personId!==person.id)return nameReviewFailure('person_mismatch',{expected:person.id,received:command.personId??null});
 if(typeof command.requestId!=='string'||!command.requestId.trim())return nameReviewFailure('missing_request_id');
 for(const field of NAME_REVIEW_IDENTITY_FIELDS)if(Object.prototype.hasOwnProperty.call(command,field))return nameReviewFailure('identity_change_forbidden',{field});
 if(!NAME_REVIEW_MODES.includes(command.mode))return nameReviewFailure('invalid_mode',{modes:[...NAME_REVIEW_MODES]});
 const value=nameReviewText(command.value);
 if(!nameReviewValid(value))return nameReviewFailure('invalid_name',{maxLength:NAME_REVIEW_MAX_LENGTH});
 if(command.basis!=null&&(typeof command.basis!=='string'||command.basis.length>NAME_REVIEW_BASIS_MAX_LENGTH))return nameReviewFailure('invalid_basis',{maxLength:NAME_REVIEW_BASIS_MAX_LENGTH});
 const roles=nameReviewRoles(command);
 if(!roles.ok)return roles;
 if(roles.roles.some(role=>role.id===person.id))return nameReviewFailure('invalid_roles',{role:person.id});
 return {ok:true,value,basis:nameReviewBasis(command.basis),roles:roles.roles};
}
// Validates one command against the current Person (and the linked roles the owner named) without
// changing anything: the shape checks, then the state checks.
function validatePersonNameReview(person,command,people=[]){
 const shape=validatePersonNameReviewShape(person,command);
 if(!shape.ok)return shape;
 const {value,basis,roles}=shape;
 if(person.identity?.status==='rejected')return nameReviewFailure('rejected_identity');
 const version=personNameVersion(person);
 if(command.expectedVersion!==version)return nameReviewFailure('version_conflict',{expected:version,received:command.expectedVersion??null});
 const options=personNameOptions(person);
 const selected=options.find(option=>option.value===value)||null;
 if(command.mode==='alias'&&!selected)return nameReviewFailure('unknown_alias',{options:options.map(option=>option.value)});
 const collisions=personNameCollisions(person,people);
 const linked=[];
 for(const role of roles){
  const record=Array.isArray(people)?people.find(item=>item?.id===role.id):null;
  if(!record)return nameReviewFailure('unknown_role',{role:role.id});
  if(!collisions.some(item=>item.id===role.id))return nameReviewFailure('unrelated_role',{role:role.id});
  if(record.identity?.status==='rejected')return nameReviewFailure('rejected_role',{role:role.id});
  const roleVersion=personNameVersion(record);
  if(role.expectedVersion!==roleVersion)return nameReviewFailure('role_version_conflict',{role:role.id,expected:roleVersion,received:role.expectedVersion??null});
  linked.push({record,version:roleVersion});
 }
 return {ok:true,value,basis,version,selected,linked};
}
// A replay is the same committed request sent again: same Person, mode, normalized value,
// normalized basis and the same set of linked roles under the same requestId. Only the primary
// record's own entry (linkedFrom null) counts; an entry a link wrote onto this record is not it.
function samePersonNameReview(review,person,command,shape){
 const roleIds=shape.roles.map(role=>role.id).sort().join('\n'),reviewRoles=(review.roles||[]).slice().sort().join('\n');
 return review.personId===person.id&&review.linkedFrom==null&&review.mode===command.mode&&review.to?.value===shape.value&&(review.basis??null)===shape.basis&&reviewRoles===roleIds;
}
function nameReviewRemoveAlias(aliases,value){return mergeAliases((aliases||[]).filter(alias=>!(alias.kind==='name'&&alias.value===value)),[]);}
function nameReviewAddLink(links,link){
 const out=(links||[]).filter(item=>item.id!==link.id);
 out.push(link);
 return nameReviewSortById(out);
}
function nameReviewCarries(record,value){return record?.localization?.status==='reviewed'&&record.localization.value===value;}
function nameReviewLinked(record,id){return (record?.roleLinks||[]).some(link=>link.id===id);}
function nameReviewEntry(record,{requestId,linkedFrom,mode,basis,selectedFrom,roles,value,nameChanged,before},at){
 return {contractVersion:NAME_REVIEW_CONTRACT_VERSION,requestId,personId:record.id,linkedFrom,at:stamp(at),mode,authority:NAME_REVIEW_AUTHORITY,basis,selectedFrom,roles,nameChanged,records:[],from:{value:record.localization?.value??null,status:record.localization?.status??'missing',source:record.localization?.source??null},to:{value,status:'reviewed'},version:{before,after:null}};
}
// Moves one record to the reviewed name with the owner's authority, keeps the previous preferred
// name as an alias, drops the chosen value from the aliases and appends one audit entry. A record
// that already carries the name keeps its localization and still gets the entry (nameChanged:
// false): the entry is the owner's assertion under this requestId, and the replay lookup needs it.
function nameReviewApplyTo(record,fields,at){
 const {value,basis,mode,requestId,selectedFrom,linkedFrom}=fields;
 const nameChanged=!nameReviewCarries(record,value);
 let moved=record;
 if(nameChanged){
  const provenance={source:NAME_REVIEW_AUTHORITY,authority:NAME_REVIEW_AUTHORITY,mode,basis,requestId,selectedFrom,linkedFrom};
  moved=applyReviewedLocalization(record,{value,authority:NAME_REVIEW_AUTHORITY,source:NAME_REVIEW_AUTHORITY,provenance},at,'name');
  if(moved.localization===record.localization)return null;
  moved={...moved,aliases:nameReviewRemoveAlias(moved.aliases,value)};
 }
 const review=nameReviewEntry(record,{...fields,nameChanged},at);
 return {next:{...moved,nameReviews:[...(record.nameReviews||[]),review]},review};
}
// Applies one review. The result carries the next Person, its audit entry, the next linked role
// records with their own audit entries, the new version and `commit`, the list of every record the
// writer has to persist with its token before and after. A repeated requestId with the same
// payload replays the earlier outcome without a second change, even with a stale or missing
// expectedVersion: the state checks guard new changes, not retries. The primary record gets an
// audit entry whenever anything changes (its name, a linked role's name or a link), so a retry of
// a link-only command replays too; only a command that changes nothing at all is a no-op.
function applyPersonNameReview(person,command,at,people=[]){
 const shape=validatePersonNameReviewShape(person,command);
 if(!shape.ok)return shape;
 const replay=(person.nameReviews||[]).find(review=>review.requestId===command.requestId);
 if(replay){
  if(samePersonNameReview(replay,person,command,shape))return {ok:true,idempotent:true,changed:false,person,people:[],review:replay,reviews:[],version:personNameVersion(person),commit:[]};
  return nameReviewFailure('request_id_reused',{review:replay});
 }
 const checked=validatePersonNameReview(person,command,people);
 if(!checked.ok)return checked;
 const {value,basis,selected,linked}=checked;
 const roleIds=linked.map(item=>item.record.id);
 const nothingToDo=nameReviewCarries(person,value)&&linked.every(item=>nameReviewCarries(item.record,value)&&nameReviewLinked(person,item.record.id)&&nameReviewLinked(item.record,person.id));
 if(nothingToDo)return {ok:true,idempotent:false,changed:false,person,people:[],review:null,reviews:[],version:checked.version,commit:[]};
 // selectedFrom names where the picked text came from: an alias reports its own source (wikidata, dictionary, letterboxd...).
 const selectedFrom=selected?(selected.origin==='alias'?selected.provenance?.source||'alias':selected.origin):null;
 const stampedAt=stamp(at);
 const applied=nameReviewApplyTo(person,{value,basis,mode:command.mode,requestId:command.requestId,selectedFrom,roles:roleIds,linkedFrom:null,before:checked.version},at);
 if(!applied)return nameReviewFailure('illegal_transition',{from:person.localization?.status??null});
 let next=applied.next;
 const review=applied.review;
 const nextPeople=[],reviews=[];
 for(const item of linked){
  const record=item.record;
  let moved=record,roleReview=null;
  // A role that already carries the name is linked without an audit entry of its own; the
  // primary record's entry lists it under `records`.
  if(!nameReviewCarries(record,value)){
   const roleApplied=nameReviewApplyTo(record,{value,basis,mode:command.mode,requestId:command.requestId,selectedFrom,roles:[],linkedFrom:person.id,before:item.version},at);
   if(!roleApplied)return nameReviewFailure('illegal_transition',{role:record.id,from:record.localization?.status??null});
   moved=roleApplied.next;roleReview=roleApplied.review;
  }
  moved={...moved,roleLinks:nameReviewAddLink(moved.roleLinks,{id:person.id,roleId:person.roleId??null,reason:NAME_REVIEW_LINK_REASON,requestId:command.requestId,at:stampedAt})};
  const after=personNameVersion(moved);
  if(roleReview){roleReview.version.after=after;reviews.push(roleReview);}
  review.records.push({id:record.id,version:{before:item.version,after}});
  nextPeople.push(moved);
  next={...next,roleLinks:nameReviewAddLink(next.roleLinks,{id:record.id,roleId:record.roleId??null,reason:NAME_REVIEW_LINK_REASON,requestId:command.requestId,at:stampedAt})};
 }
 review.version.after=personNameVersion(next);
 const commit=[{id:next.id,version:{before:checked.version,after:review.version.after}},...review.records.map(item=>({id:item.id,version:{...item.version}}))];
 return {ok:true,idempotent:false,changed:true,person:next,people:nextPeople,review,reviews,version:review.version.after,commit};
}
// Completion check for a multi-record result after a crash or a partial write. Given the primary
// record's audit entry for a requestId and the records as they are stored now, each record is
// `applied` when its token is the entry's `after`, `pending` when it is still the `before` (the
// write never landed) and `diverged` otherwise (something else changed it since). A writer that
// cannot persist every record of `commit` in one atomic write must run this before answering a
// retry: a replay on the primary record alone says nothing about the linked roles.
function personNameReviewCompletion(review,person,people=[]){
 if(!review||typeof review!=='object'||!review.version)return {complete:false,records:[]};
 const state=(record,version)=>{if(!record)return 'missing';const token=personNameVersion(record);return token===version.after?'applied':token===version.before?'pending':'diverged';};
 const records=[{id:review.personId??person?.id??null,state:person?.id===review.personId?state(person,review.version):'missing'}];
 for(const item of review.records||[])records.push({id:item.id,state:state(Array.isArray(people)?people.find(record=>record?.id===item.id):null,item.version)});
 return {complete:records.every(item=>item.state==='applied'),records};
}
// Reviewed precedence for later inputs. The owner's reviewed name is kept against any later value,
// automatic or dictionary: the incoming value is held in localizationConflicts with reason
// `owner_kept` (the vocabulary src/sources.js already uses) and kept as an alias. A record the
// owner has not reviewed follows the lifecycle contract: a reviewed dictionary value promotes or
// replaces, an automatic value stays provisional and cannot touch a reviewed name.
function reconcilePersonName(person,incoming,at){
 if(!person?.localization)return person;
 const current=person.localization;
 if(current.status==='reviewed'&&current.provenance?.authority===NAME_REVIEW_AUTHORITY){
  if(!incoming?.value||incoming.value===current.value)return person;
  return holdLocalization(person,incoming,at,'name','owner_kept');
 }
 if(incoming?.status==='reviewed'&&(incoming.authority==='dictionary'||incoming.authority===NAME_REVIEW_AUTHORITY))return applyReviewedLocalization(person,incoming,at,'name');
 return applyAutomaticLocalization(person,incoming,at,'name');
}
