// AIR-631 (card PV1; ADR 0214, Accepted). The per-field provenance of film_metadata: the stored-row reader, the value binding, the ONE comparator (decisions 3, 5 and 7), the owner actions (decision 9) and the history rows.
// DORMANT, like the film writers module, which is its only caller: schema absent (migration 0049 not applied) or control mode `off` leaves today's statements untouched. Nothing here reads R2, scores a Film or writes identity;
// it never runs a statement itself. planMetadataProvenance is PURE over the snapshot readFilmSnapshot took, so it stays synchronous (the SHA-256 below is synchronous for that reason; tests/film-metadata-provenance.mjs proves it equals crypto).
import {computeAnchors,anchorSetGuard,canonicalJson} from './catalog-enrichment-plan.js';
import {failed,many,one} from './film-person-authority.js';

export const FIELDS=Object.freeze(['year','runtime','synopsis','poster','url','genres']);
export const COLUMN_OF=Object.freeze({year:'year',runtime:'runtime',synopsis:'synopsis',poster:'poster',url:'url',genres:'genres_json'});
const PRECEDENCE=Object.freeze({letterboxd:2,tmdb:1});
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const HEX64=/^[0-9a-f]{64}$/;
const FUTURE_SLACK_MS=60000;
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const parse=text=>{if(text==null)return null;try{return JSON.parse(text);}catch{return null;}};
const instant=value=>{if(typeof value!=='string'||!ISO.test(value))return null;const ms=Date.parse(value);return Number.isFinite(ms)?new Date(ms).toISOString():null;};
const noTable=error=>/no such table/i.test(String(error?.cause?.message||error?.message||error));

// ---- a synchronous SHA-256 (FIPS 180-4), because the planner is synchronous. Constants are derived, not typed: the fractional parts of the roots of the first primes. ----
const PRIMES=(()=>{const out=[];for(let n=2;out.length<64;n++)if(out.every(p=>n%p!==0))out.push(n);return out;})();
const frac=value=>Math.floor((value-Math.floor(value))*4294967296)>>>0;
const K=Uint32Array.from(PRIMES,p=>frac(Math.cbrt(p)));
const H0=Uint32Array.from(PRIMES.slice(0,8),p=>frac(Math.sqrt(p)));
const rotr=(x,n)=>(x>>>n)|(x<<(32-n));
export function sha256Hex(text){
 const bytes=new TextEncoder().encode(String(text)),length=bytes.length,total=((length+9+63)>>6)<<6,buffer=new Uint8Array(total);
 buffer.set(bytes);buffer[length]=0x80;
 const view=new DataView(buffer.buffer);
 view.setUint32(total-8,Math.floor(length/536870912));view.setUint32(total-4,(length*8)>>>0);
 const h=Uint32Array.from(H0),w=new Uint32Array(64);
 for(let offset=0;offset<total;offset+=64){
  for(let i=0;i<16;i++)w[i]=view.getUint32(offset+i*4);
  for(let i=16;i<64;i++){const s0=rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3),s1=rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10);w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;}
  let [a,b,c,d,e,f,g,k]=h;
  for(let i=0;i<64;i++){
   const t1=(k+(rotr(e,6)^rotr(e,11)^rotr(e,25))+((e&f)^(~e&g))+K[i]+w[i])>>>0,t2=((rotr(a,2)^rotr(a,13)^rotr(a,22))+((a&b)^(a&c)^(b&c)))>>>0;
   k=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
  }
  [a,b,c,d,e,f,g,k].forEach((value,i)=>{h[i]=(h[i]+value)>>>0;});
 }
 return [...h].map(value=>value.toString(16).padStart(8,'0')).join('');
}

// ---- values ----
const blankValue=value=>value===undefined||value===null||(typeof value==='string'&&value.trim()==='')||(Array.isArray(value)&&!value.length);
// The value as the row stores it: integers for year and runtime, text as given, genres as the array. A blank is null. Never trimmed: the digest binds the stored bytes.
export function normalizeValue(field,value){
 if(blankValue(value))return null;
 if(field==='genres')return Array.isArray(value)?value:null;
 if(field==='year'||field==='runtime'){const number=typeof value==='string'&&/^\d+$/.test(value.trim())?Number(value):value;return Number.isInteger(number)?number:null;}
 return typeof value==='string'?value:String(value);
}
export const valueText=value=>JSON.stringify(value);
export const valueDigest=value=>sha256Hex(valueText(value));
export const storedValue=(row,field)=>row?normalizeValue(field,field==='genres'?parse(row.genres_json):row[field]):null;
const same=(left,right)=>valueText(left)===valueText(right);

// The owner's own values: bounded and typed (ADR 0214 decision 9). Anything else is film_person_invalid.
function ownerValue(field,value){
 const out=normalizeValue(field,value);
 const bad=()=>failed('film_person_invalid');
 if(out===null)throw bad();
 if(field==='year'&&!(out>=1870&&out<=2200))throw bad();
 if(field==='runtime'&&!(out>=1&&out<=10000))throw bad();
 if(field==='synopsis'&&out.length>20000)throw bad();
 if(field==='poster'&&out.length>2000)throw bad();
 if(field==='url'&&(out.length>2000||!/^https?:\/\//.test(out)))throw bad();
 if(field==='genres'&&(out.length>40||out.some(item=>typeof item!=='string'||!item.trim()||item.length>80)))throw bad();
 return out;
}

// ---- reading (ONE Film). null = the control table does not exist (today's behaviour). ----
const ANCHOR_SQL=`SELECT e.scheme,e.value,e.trusted,e.conflicting,EXISTS (SELECT 1 FROM film_external_id o WHERE o.scheme=e.scheme AND o.value=e.value AND o.trusted=1 AND o.film_id<>e.film_id) AS other_owner,EXISTS (SELECT 1 FROM tmdb_retirement_decision r WHERE e.scheme='tmdb' AND r.film_id=e.film_id AND r.movie_id=e.value AND r.kind='retire' AND NOT EXISTS (SELECT 1 FROM tmdb_retirement_decision s WHERE s.supersedes_seq=r.seq)) AS retired FROM film_external_id e WHERE e.film_id=? AND e.scheme IN ('tmdb','letterboxd') AND e.trusted=1`;
const ANCHOR_SQL_NO_RETIREMENT=`SELECT e.scheme,e.value,e.trusted,e.conflicting,EXISTS (SELECT 1 FROM film_external_id o WHERE o.scheme=e.scheme AND o.value=e.value AND o.trusted=1 AND o.film_id<>e.film_id) AS other_owner,0 AS retired FROM film_external_id e WHERE e.film_id=? AND e.scheme IN ('tmdb','letterboxd') AND e.trusted=1`;
const FIELD_COLUMNS='field,tier,source,origin,anchor_scheme,anchor_value,anchor_digest,agreement,observed_at,checked_at,value_digest,write_key,written_revision,updated_at';
export async function readProvenance(db,filmId){
 let control;
 try{control=await one(db,'SELECT mode,revision FROM film_metadata_provenance_control WHERE id=1');}
 catch(error){if(noTable(error))return null;throw failed('film_person_unavailable',error);}
 // An absent control row while the table exists, or a mode outside the contract, fails the metadata write closed.
 if(!control||!['off','enforce','hold'].includes(control.mode)||!Number.isInteger(Number(control.revision)))throw failed('film_person_unavailable');
 const out={mode:control.mode,revision:Number(control.revision),fields:{},anchors:null,disagreement:false,disagreementTable:false};
 if(control.mode==='off')return out;
 try{
  const [rows,anchorRows,state]=await Promise.all([
   many(db,`SELECT ${FIELD_COLUMNS} FROM film_metadata_field WHERE film_id=?`,[filmId]),
   many(db,ANCHOR_SQL,[filmId]).catch(error=>{if(noTable(error))return many(db,ANCHOR_SQL_NO_RETIREMENT,[filmId]);throw error;}),
   one(db,"SELECT 1 AS present FROM catalog_enrichment_state WHERE film_id=? AND part='film' AND source='*' AND status='identity_disagreement'",[filmId]).then(row=>({table:true,present:!!row})).catch(error=>{if(noTable(error))return {table:false,present:false};throw error;}),
  ]);
  for(const row of rows)out.fields[row.field]=row;
  const computed=computeAnchors(anchorRows.map(row=>({scheme:row.scheme,value:row.value,trusted:row.trusted,conflicting:row.conflicting,otherOwner:!!row.other_owner,retired:!!row.retired})));
  out.anchors={computed,digest:sha256Hex(canonicalJson({anchors:computed.digestRows}))};
  out.disagreement=state.present;out.disagreementTable=state.table;
 }catch(error){throw failed('film_person_unavailable',error);}
 return out;
}

// ---- confidence and rank (decision 3) ----
const CONFIDENCE={owner:5,confirmed:4,superseded:3,unconfirmed:2,unknown:1};
function standing(row,value,digest,dimLocked){
 const bound=!!row&&value!==null&&row.value_digest===valueDigest(value);
 const mismatch=!!row&&value!==null&&!bound;
 if(dimLocked)return {name:'owner',rank:5,bound,mismatch,row};
 if(row&&row.tier==='owner')return {name:'owner',rank:5,bound,mismatch,row};
 if(!bound||row.tier!=='automatic')return {name:'unknown',rank:1,bound,mismatch,row:null};
 if(row.anchor_digest!==digest)return {name:'superseded',rank:3,bound,mismatch,row};
 return row.agreement==='unconfirmed'?{name:'unconfirmed',rank:2,bound,mismatch,row}:{name:'confirmed',rank:4,bound,mismatch,row};
}
const rankOf=(rank,source,observedAt,digest)=>[rank,PRECEDENCE[source]||0,observedAt||'',digest||''];
const compare=(left,right)=>{for(let i=0;i<4;i++){if(left[i]<right[i])return -1;if(left[i]>right[i])return 1;}return 0;};
export const confidenceOf=standing;

const HISTORY_SQL='INSERT INTO film_metadata_history (film_id,field,reason,old_value_text,old_tier,old_source,old_anchor_scheme,old_anchor_value,old_anchor_digest,old_agreement,old_observed_at,new_value_digest,new_tier,new_source,new_anchor_digest,write_key,at,merged_from) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(film_id,field,write_key) DO NOTHING';
export const FIELD_UPSERT='INSERT INTO film_metadata_field (film_id,field,tier,source,origin,anchor_scheme,anchor_value,anchor_digest,agreement,observed_at,checked_at,value_digest,write_key,written_revision,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(film_id,field) DO UPDATE SET tier=excluded.tier,source=excluded.source,origin=excluded.origin,anchor_scheme=excluded.anchor_scheme,anchor_value=excluded.anchor_value,anchor_digest=excluded.anchor_digest,agreement=excluded.agreement,observed_at=excluded.observed_at,checked_at=excluded.checked_at,value_digest=excluded.value_digest,write_key=excluded.write_key,written_revision=excluded.written_revision,updated_at=excluded.updated_at';
export const historyStatement=(filmId,field,reason,old,next,writeKey,at,mergedFrom=null)=>[HISTORY_SQL,[filmId,field,reason,old?.valueText??null,old?.tier??null,old?.source??null,old?.anchorScheme??null,old?.anchorValue??null,old?.anchorDigest??null,old?.agreement??null,old?.observedAt??null,next?.valueDigest??null,next?.tier??null,next?.source??null,next?.anchorDigest??null,writeKey,at,mergedFrom]];
// The old value and its semantic columns for a history row; the columns are null when the old value was `unknown` (no bound row).
function oldOf(value,stand){
 if(value===null)return null;
 const row=stand.row&&stand.bound?stand.row:null;
 return {valueText:valueText(value),tier:row?.tier??null,source:row?.source??null,anchorScheme:row?.anchor_scheme??null,anchorValue:row?.anchor_value??null,anchorDigest:row?.anchor_digest??null,agreement:row?.agreement??null,observedAt:row?.observed_at??null};
}
const fieldRow=(filmId,field,row,value,writeKey,revision,at)=>[FIELD_UPSERT,[filmId,field,row.tier,row.source,row.origin,row.anchorScheme??null,row.anchorValue??null,row.anchorDigest??null,row.agreement??null,row.observedAt,row.checkedAt??at,valueDigest(value),writeKey,revision,at]];

export const emptyCounts=()=>({fills:0,adoptions:0,replacements:0,agreed:0,refusals:{owner_kept:0,stored_differs:0,disagreement:0,anchor_changed:0,attributed_kept:0,hold:0},source_absent:0,same_rank_conflict:0,agreement_stale:0,provenance_mismatch:0,history:0,owner_actions:0});

// PURE. The metadata part of planFilmFacts under mode `enforce` or `hold`. `snapshot.provenance` is readProvenance's result. Returns
// {effective, post, changes, skipped, guards, counts, owner, declared}: `effective` is what mergeMetadata receives (a field that is not written is null, so the stored value survives), `post` the statements that follow the value upsert, `pre` the release-row insert.
export function planMetadataProvenance(snapshot,input,at){
 const prov=snapshot.provenance,mode=prov.mode,meta=input.metadata,id=snapshot.id;
 const atIso=instant(at);
 if(!atIso)throw failed('film_person_invalid');
 const auth=input.metadataAuthority;
 if(auth!==undefined&&(!plain(auth)||auth.authority!=='owner'||auth.origin!=='owner_route'))throw failed('film_person_invalid');
 const owner=auth!==undefined;
 if(meta.ownerActions!==undefined&&(!owner||!Array.isArray(meta.ownerActions)))throw failed('film_person_invalid');
 if(meta.declared!==undefined&&(owner||!plain(meta.declared)))throw failed('film_person_invalid');
 const declared=meta.declared||{};
 for(const field of Object.keys(declared)){
  const item=declared[field];
  if(!FIELDS.includes(field)||!plain(item)||!['letterboxd','tmdb'].includes(item.source)||!plain(item.anchor)||item.anchor.scheme!==item.source||typeof item.anchor.value!=='string'||!item.anchor.value)throw failed('film_person_invalid');
  const observed=instant(item.observedAt);
  if(!observed||Date.parse(observed)>Date.parse(atIso)+FUTURE_SLACK_MS)throw failed('film_person_invalid');
  if(item.agreedAnchorDigest!==undefined&&item.agreedAnchorDigest!==null&&!HEX64.test(item.agreedAnchorDigest))throw failed('film_person_invalid');
 }
 const revision=(Number.isInteger(input.expectedRevision)?input.expectedRevision:snapshot.revision)+1,writeKey=String(input.requestId).slice(0,200);
 const row=snapshot.metadata,digest=prov.anchors.digest,computed=prov.anchors.computed;
 const dimLocked=!!snapshot.dimensions.metadata&&(snapshot.dimensions.metadata.status==='reviewed'||snapshot.dimensions.metadata.authority==='owner');
 const out={effective:{...meta},post:[],pre:[],changes:[],skipped:[],rejected:[],guards:[],counts:emptyCounts(),owner,declared:Object.keys(declared).length>0,fences:{anchor:false},lockedEmpty:false};
 // ADR 0214 decision 9: an owner action the rules refuse is REJECTED (no effect, no command record, no revision), never a skipped no-op; the caller (planFilmFacts) throws film_metadata_rejected.
 const reject=(field,reason)=>{out.rejected.push({field,reason});out.skipped.push({field,reason});};
 const history=(field,reason,old,next)=>{out.post.push(historyStatement(id,field,reason,old,next,writeKey,atIso));out.counts.history++;};
 for(const field of FIELDS)if(meta[field]!==undefined)out.effective[field]=null; // only a field that is written below is passed on
 const actions=new Map();
 for(const action of meta.ownerActions||[]){
  if(!plain(action)||!['set','lock','release','revert'].includes(action.action)||!FIELDS.includes(action.field)||actions.has(action.field))throw failed('film_person_invalid');
  actions.set(action.field,action);
 }
 let anchorGuard=false,disagreementGuard=false;
 for(const field of FIELDS){
  const stored=storedValue(row,field),stand=standing(prov.fields[field],stored,digest,dimLocked);
  if(stand.mismatch){out.counts.provenance_mismatch++;}
  const old=oldOf(stored,stand);
  // ---- owner actions: owner authority is the only way past a lock ----
  if(actions.has(field)){
   const action=actions.get(field),current=prov.fields[field];
   out.counts.owner_actions++;
   const ownerRow=(tier,source,origin,lineage,value)=>fieldRow(id,field,{tier,source,origin,anchorScheme:lineage.anchorScheme,anchorValue:lineage.anchorValue,anchorDigest:lineage.anchorDigest,agreement:null,observedAt:lineage.observedAt||atIso,checkedAt:atIso},value,writeKey,revision,atIso);
   if(action.action==='set'){
    const value=ownerValue(field,action.value);
    const alreadyOwner=current?.tier==='owner'&&current.source==='owner'&&same(stored,value)&&current.value_digest===valueDigest(value)&&current.anchor_digest===digest;
    if(alreadyOwner)continue;
    out.effective[field]=value;
    history(field,'owner_set',old,{valueDigest:valueDigest(value),tier:'owner',source:'owner',anchorDigest:digest});
    out.post.push(ownerRow('owner','owner','owner_route',{anchorScheme:null,anchorValue:null,anchorDigest:digest,observedAt:atIso},value));
    out.changes.push('owner_set:'+field);
   }else if(action.action==='lock'){
    if(stored===null){reject(field,'blank_field');continue;}
    if(current?.tier==='owner'&&stand.bound)continue;
    const keep=stand.name==='confirmed'||stand.name==='superseded'||stand.name==='unconfirmed'?stand.row:null;
    history(field,'owner_lock',old,{valueDigest:valueDigest(stored),tier:'owner',source:keep?keep.source:'unattributed',anchorDigest:keep?keep.anchor_digest:null});
    out.post.push(keep
     ?ownerRow('owner',keep.source,keep.origin,{anchorScheme:keep.anchor_scheme,anchorValue:keep.anchor_value,anchorDigest:keep.anchor_digest,observedAt:keep.observed_at},stored)
     :ownerRow('owner','unattributed','owner_route',{anchorScheme:null,anchorValue:null,anchorDigest:null,observedAt:atIso},stored));
    out.changes.push('owner_lock:'+field);
   }else if(action.action==='release'){
    if(!current||current.tier!=='owner'){continue;}
    history(field,'owner_release',old,{valueDigest:current.value_digest,tier:'released',source:current.source,anchorDigest:current.anchor_digest});
    out.post.push([ 'UPDATE film_metadata_field SET tier=?,agreement=NULL,checked_at=?,write_key=?,written_revision=?,updated_at=? WHERE film_id=? AND field=? AND tier=?',['released',atIso,writeKey,revision,atIso,id,field,'owner']]);
    out.changes.push('owner_release:'+field);
   }else{
    const hist=action.history;
    if(!plain(hist)||!Number.isInteger(hist.id)||hist.field!==field||typeof hist.oldValueText!=='string')throw failed('film_person_invalid');
    if(hist.oldAnchorDigest==null){reject(field,'identity_unknown');continue;}
    if(hist.oldAnchorDigest!==digest){reject(field,'anchor_changed');continue;}
    const value=ownerValue(field,parse(hist.oldValueText));
    // the caller's history row is bound to the STORED immutable row in the batch: every lineage column it restores must equal the stored one, and the row must belong to this Film or to a Film redirected into it (one hop)
    out.guards.push({sql:'EXISTS (SELECT 1 FROM film_metadata_history h WHERE h.id=? AND h.field=? AND h.old_value_text=? AND h.old_source IS ? AND h.old_anchor_scheme IS ? AND h.old_anchor_value IS ? AND h.old_anchor_digest IS ? AND h.old_observed_at IS ? AND (h.film_id=? OR h.film_id IN (SELECT r.from_id FROM film_redirect r WHERE r.to_film_id=?)))',params:[hist.id,field,hist.oldValueText,hist.oldSource??null,hist.oldAnchorScheme??null,hist.oldAnchorValue??null,hist.oldAnchorDigest,hist.oldObservedAt??null,id,id]});
    anchorGuard=true;
    const source=hist.oldSource||'owner',lineageOwned=source==='owner'||source==='unattributed';
    out.effective[field]=value;
    history(field,'owner_revert',old,{valueDigest:valueDigest(value),tier:'owner',source,anchorDigest:digest});
    out.post.push(ownerRow('owner',source,lineageOwned?'owner_route':'catalog_enrichment',{anchorScheme:hist.oldAnchorScheme??null,anchorValue:hist.oldAnchorValue??null,anchorDigest:digest,observedAt:hist.oldObservedAt||atIso},value));
    out.changes.push('owner_revert:'+field);
   }
   continue;
  }
  // ---- automatic writers ----
  const incoming=normalizeValue(field,meta[field]);
  if(meta[field]===undefined)continue;
  const decl=declared[field];
  if(incoming===null){
   if(decl&&stand.row&&stand.row.source===decl.source&&stored!==null)out.counts.source_absent++;
   continue; // a blank never clears
  }
  if(stand.name==='owner'){out.skipped.push({field,reason:'owner_kept'});out.counts.refusals.owner_kept++;continue;}
  const fill=()=>{out.effective[field]=incoming;out.counts.fills++;};
  if(!decl){
   // undeclared: ranks `unknown`. It fills a blank, replaces an unknown value with history, never an attributed one, and in `hold` only fills.
   if(stored===null){fill();continue;}
   if(same(stored,incoming))continue;
   if(mode==='hold'){out.skipped.push({field,reason:'hold_fill_only'});out.counts.refusals.hold++;continue;}
   if(stand.name!=='unknown'){out.skipped.push({field,reason:'attributed_kept'});out.counts.refusals.attributed_kept++;continue;}
   history(field,'replaced',old,{valueDigest:valueDigest(incoming),tier:null,source:null,anchorDigest:null});
   out.effective[field]=incoming;out.counts.replacements++;
   continue;
  }
  // declared (catalog enrichment): the anchor it relied on must still be the Film's anchor of that source
  const anchor=computed[decl.source];
  if(!anchor||anchor.value!==decl.anchor.value)throw failed('film_person_precondition');
  if(prov.disagreement){out.skipped.push({field,reason:'disagreement'});out.counts.refusals.disagreement++;continue;}
  const agreement=computed.letterboxd?(decl.agreedAnchorDigest===digest?'confirmed':'unconfirmed'):'not_required';
  if(agreement==='unconfirmed')out.counts.agreement_stale++;
  const observedAt=instant(decl.observedAt),vDigest=valueDigest(incoming);
  const vRank=rankOf(agreement==='unconfirmed'?2:4,decl.source,observedAt,vDigest);
  const sRank=rankOf(stand.rank,stand.row?.source,stand.row?.observed_at,stand.row?.value_digest);
  const next={tier:'automatic',source:decl.source,origin:'catalog_enrichment',anchorScheme:decl.anchor.scheme,anchorValue:decl.anchor.value,anchorDigest:digest,agreement,observedAt,checkedAt:atIso};
  const upsert=()=>out.post.push(fieldRow(id,field,next,incoming,writeKey,revision,atIso));
  anchorGuard=true;
  if(stored===null){fill();upsert();out.changes.push('provenance:'+field);continue;}
  if(same(stored,incoming)){
   if(compare(vRank,sRank)>0){upsert();out.counts.adoptions++;out.changes.push('adopt:'+field);}
   // the very same observation seen again by a later write: only the audit column moves (ADR 0214 decision 5, `agreed`); a different tuple that outranks adopts, which keeps the semantic projection order-independent
   else if(compare(vRank,sRank)===0&&stand.row&&stand.name!=='unknown'&&atIso>stand.row.checked_at){
    out.post.push(['UPDATE film_metadata_field SET checked_at=?,write_key=?,written_revision=?,updated_at=? WHERE film_id=? AND field=? AND value_digest=?',[atIso,writeKey,revision,atIso,id,field,vDigest]]);
    out.counts.agreed++;out.changes.push('agreed:'+field);
   }
   continue;
  }
  if(mode==='hold'){out.skipped.push({field,reason:'hold_fill_only'});out.counts.refusals.hold++;continue;}
  if(vRank[0]===4&&compare(vRank,sRank)>0){
   if(vRank[0]===sRank[0]&&vRank[1]===sRank[1]&&vRank[2]===sRank[2])out.counts.same_rank_conflict++;
   history(field,'replaced',old,{valueDigest:vDigest,tier:'automatic',source:decl.source,anchorDigest:digest});
   out.effective[field]=incoming;out.counts.replacements++;upsert();out.changes.push('replace:'+field);
   continue;
  }
  out.skipped.push({field,reason:'stored_differs'});out.counts.refusals.stored_differs++;
 }
 // fences (decision 4): a declared batch asserts the planned anchor set; an automatic declared batch also asserts no known disagreement. An owner batch asserts neither (a revert adds its own anchor assertion above).
 if(anchorGuard&&!out.guards.some(guard=>guard.anchorSet))out.guards.unshift(Object.assign(anchorSetGuard(id,computed),{anchorSet:true}));
 if(out.declared&&prov.disagreementTable)out.guards.push({sql:"NOT EXISTS (SELECT 1 FROM catalog_enrichment_state WHERE film_id=? AND part='film' AND source='*' AND status='identity_disagreement')",params:[id]});
 // A Film that is locked (its metadata dimension, or an owner field row) and has no metadata row is protected too: an automatic writer must not even create the row (the destination trigger would abort the batch)
 out.lockedEmpty=!owner&&!snapshot.metadata&&(dimLocked||Object.values(prov.fields).some(item=>item.tier==='owner'));
 // owner batch: the release row is the FIRST statement and is deleted LAST, so the lock triggers let this batch through and it never stays
 if(owner){out.pre.push(['INSERT OR IGNORE INTO film_metadata_owner_release (film_id) VALUES (?)',[id]]);out.post.push(['DELETE FROM film_metadata_owner_release WHERE film_id=?',[id]]);}
 return out;
}

// PURE. `metadata: null` under mode `enforce` or `hold` (decision 9). Returns {pre, post, counts, owner} (statements before and after the row's own delete) or throws the refusal.
export function planMetadataClear(snapshot,input,at){
 const prov=snapshot.provenance,id=snapshot.id,row=snapshot.metadata;
 const atIso=instant(at);
 if(!atIso)throw failed('film_person_invalid');
 const auth=input.metadataAuthority;
 if(auth!==undefined&&(!plain(auth)||auth.authority!=='owner'||auth.origin!=='owner_route'))throw failed('film_person_invalid');
 const owner=auth!==undefined,digest=prov.anchors.digest;
 const dimLocked=!!snapshot.dimensions.metadata&&(snapshot.dimensions.metadata.status==='reviewed'||snapshot.dimensions.metadata.authority==='owner');
 const writeKey=String(input.requestId).slice(0,200);
 const rows=FIELDS.map(field=>{const value=storedValue(row,field);return {field,value,stand:standing(prov.fields[field],value,digest,dimLocked),raw:prov.fields[field]};});
 const pinned=dimLocked||rows.some(item=>item.raw&&item.raw.tier==='owner');
 if(pinned&&!owner)throw failed('film_metadata_locked');
 if(!owner&&rows.some(item=>item.stand.name!=='unknown'&&item.value!==null))throw failed('film_metadata_attributed');
 if(!owner&&prov.mode==='hold')throw failed('film_metadata_hold');
 const pre=[],post=[],counts=emptyCounts();
 if(owner)pre.push(['INSERT OR IGNORE INTO film_metadata_owner_release (film_id) VALUES (?)',[id]]);
 for(const item of rows){if(item.value===null)continue;pre.push(historyStatement(id,item.field,'cleared',oldOf(item.value,item.stand),null,writeKey,atIso));counts.history++;}
 // the row's own delete (the caller's statement) fires the invalidation trigger for non-owner rows; this removes whatever remains, owner rows included under the release row
 post.push(['DELETE FROM film_metadata_field WHERE film_id=?',[id]]);
 // an owner clear that removed pins is an actual protection release: wake the core part (the delete under the release row cannot tell it from a move, so the writer says it)
 if(owner&&!dimLocked&&rows.some(item=>item.raw&&item.raw.tier==='owner'))post.push(["INSERT INTO enrichment_signal (kind, subject, source, part, version, acked_version, state, cause_ref, armed_at, attempts) VALUES ('protection_released', ?, '', 'core', 1, 0, 'pending', 'film_metadata_clear', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0) ON CONFLICT (kind, subject, source, part) DO UPDATE SET version = version + 1, state = 'pending', cause_ref = excluded.cause_ref, armed_at = excluded.armed_at, attempts = 0, last_error = NULL, retry_at = NULL",[id]]);
 if(owner)post.push(['DELETE FROM film_metadata_owner_release WHERE film_id=?',[id]]);
 return {pre,post,counts,owner};
}

// ---- the merge (dormant mergeFilms, ADR 0214 decision 9) ----
// null while the control table does not exist; otherwise {mode, revision}. An unreadable control row fails the merge closed.
export async function readControl(db){
 try{
  const row=await one(db,'SELECT mode,revision FROM film_metadata_provenance_control WHERE id=1');
  if(!row||!['off','enforce','hold'].includes(row.mode))throw failed('film_person_unavailable');
  return {mode:row.mode,revision:Number(row.revision)};
 }catch(error){
  if(error?.code)throw error;
  if(noTable(error))return null;
  throw failed('film_person_unavailable',error);
 }
}
const META_SELECT='SELECT schema_version,year,runtime,synopsis,poster,url,genres_json,people_version,payload_json,r2_key,content_sha256,updated_at FROM film_metadata WHERE film_id=?';
const dimLockedRow=row=>!!row&&(row.status==='reviewed'||row.authority==='owner');
// Field-wise merge of the two Films' metadata: the six values plus their field rows, assembled field by field (no whole-row choice). Returns
// {pre, items, post, bodyFromRetired, discarded}: `pre` inserts the release rows (only when a pin or a dimension lock is involved), `items` are the assembling statements, `post` removes what is left under the retired Film and the release rows.
// The retired Film's own history stays under its id; a discarded value (either side) gets a `merge_discarded` row under the survivor with `merged_from` = the retired Film. Differing values need `resolve.metadata` ('survivor'|'retired'), and a pin needs the per-field `resolve.metadataFields[field]`.
export async function reconcileMetadata(db,from,to,resolve,at){
 const atIso=instant(at);
 if(!atIso)throw failed('film_person_invalid');
 const choose=(value)=>{if(value!==undefined&&!['survivor','retired'].includes(value))throw failed('film_person_invalid');return value;};
 const perField=resolve?.metadataFields;
 if(perField!==undefined&&(!plain(perField)||Object.keys(perField).some(key=>!FIELDS.includes(key))))throw failed('film_person_invalid');
 const [fromRow,toRow,fromProv,toProv,fromDim,toDim]=await Promise.all([one(db,META_SELECT,[from]),one(db,META_SELECT,[to]),readProvenance(db,from),readProvenance(db,to),one(db,"SELECT status,authority FROM film_dimension WHERE film_id=? AND dimension='metadata'",[from]),one(db,"SELECT status,authority FROM film_dimension WHERE film_id=? AND dimension='metadata'",[to])]);
 const out={pre:[],items:[],post:[],bodyFromRetired:false,discarded:[]};
 const writeKey='merge:'+from+'>'+to;
 // a retired Film with no metadata row has nothing to merge: no release row is inserted, so none can stay behind
 if(!fromRow)return out;
 const lockedFrom=dimLockedRow(fromDim),lockedTo=dimLockedRow(toDim);
 const pinnedRow=(prov,field)=>!!prov&&prov.fields[field]?.tier==='owner';
 const anyPin=lockedFrom||lockedTo||FIELDS.some(field=>pinnedRow(fromProv,field)||pinnedRow(toProv,field));
 if(anyPin){out.pre.push(['INSERT OR IGNORE INTO film_metadata_owner_release (film_id) VALUES (?)',[from]]);out.pre.push(['INSERT OR IGNORE INTO film_metadata_owner_release (film_id) VALUES (?)',[to]]);}
 const releaseDone=()=>{if(anyPin){out.post.push(['DELETE FROM film_metadata_owner_release WHERE film_id=?',[from]]);out.post.push(['DELETE FROM film_metadata_owner_release WHERE film_id=?',[to]]);}};
 // the retired Film's field rows under the survivor's id (a moved row); the trigger of the row move removes the non-owner ones first, so every row is written explicitly after it
 const moved=(field,row)=>[FIELD_UPSERT,[to,field,row.tier,row.source,row.origin,row.anchor_scheme,row.anchor_value,row.anchor_digest,row.agreement,row.observed_at,row.checked_at,row.value_digest,row.written_revision?row.write_key:writeKey,row.written_revision,row.updated_at]];
 // The row that describes a value: a pin always, an automatic row only while it is bound to its value. Anything else is `unknown` (no row).
 const effective=(raw,stand)=>raw&&(raw.tier==='owner'||stand.bound)?raw:null;
 const semantic=row=>row?JSON.stringify([row.tier,row.source,row.anchor_scheme,row.anchor_value,row.anchor_digest,row.agreement,row.observed_at,row.value_digest]):null;
 const discard=(film,prov,dim,field,value,stand)=>{const row=effective(prov?.fields[field],stand);const old=oldOf(value,{row,bound:!!row});out.items.push(historyStatement(to,field,'merge_discarded',old,null,writeKey,atIso,from));out.discarded.push('metadata:'+field+':'+(film===from?'retired':'survivor'));};
 if(!toRow){
  // the survivor holds no metadata row: the retired row moves whole, with its field rows
  out.items.push(['UPDATE film_metadata SET film_id=? WHERE film_id=?',[to,from]]);
  out.items.push(['DELETE FROM film_metadata_field WHERE film_id=?',[from]]);
  for(const field of FIELDS){
   const value=storedValue(fromRow,field),row=fromProv?.fields[field];
   if(value!==null&&row&&(row.tier==='owner'||row.value_digest===valueDigest(value)))out.items.push(moved(field,row));
  }
  out.bodyFromRetired=true;
  releaseDone();
  return out;
 }
 const sets=[],params=[];
 for(const field of FIELDS){
  const fromValue=storedValue(fromRow,field),toValue=storedValue(toRow,field);
  const fromStand=standing(fromProv?.fields[field],fromValue,fromProv?.anchors.digest,lockedFrom),toStand=standing(toProv?.fields[field],toValue,toProv?.anchors.digest,lockedTo);
  const fromPinned=fromValue!==null&&(lockedFrom||pinnedRow(fromProv,field)),toPinned=toValue!==null&&(lockedTo||pinnedRow(toProv,field));
  const retiredRow=()=>effective(fromProv?.fields[field],fromStand);
  // the chosen value's exact provenance (absence included) replaces whatever the survivor held for the field: an unknown retired value leaves NO row, so a survivor pin is deleted with the value it described
  const takeRetired=()=>{if(fromValue!==null){sets.push(COLUMN_OF[field]+'=?');params.push(field==='genres'?valueText(fromValue):fromValue);}const row=retiredRow();if(row)out.items.push(moved(field,row));else out.items.push(['DELETE FROM film_metadata_field WHERE film_id=? AND field=?',[to,field]]);out.bodyFromRetired=true;};
  if(fromValue===null)continue;
  if(toValue===null){takeRetired();continue;}
  if(same(fromValue,toValue)){
   // equal values: the pin is preserved by default; with two pins the survivor's is kept
   const fromRank=rankOf(fromStand.rank,fromStand.row?.source,fromStand.row?.observed_at,fromStand.row?.value_digest),toRank=rankOf(toStand.rank,toStand.row?.source,toStand.row?.observed_at,toStand.row?.value_digest);
   const rowsEqual=semantic(retiredRow())===semantic(effective(toProv?.fields[field],toStand));
   if(rowsEqual)continue;
   const retiredWins=toPinned?false:fromPinned?true:compare(fromRank,toRank)>0;
   if(retiredWins){if(effective(toProv?.fields[field],toStand))discard(to,toProv,toDim,field,toValue,toStand);const row=retiredRow();if(row)out.items.push(moved(field,row));else out.items.push(['DELETE FROM film_metadata_field WHERE film_id=? AND field=?',[to,field]]);}
   else if(retiredRow())discard(from,fromProv,fromDim,field,fromValue,fromStand);
   continue;
  }
  // different values
  const pick=fromPinned||toPinned?choose(perField?.[field]):choose(resolve?.metadata);
  if(!pick)throw failed('film_person_data_conflict');
  if(pick==='retired'){discard(to,toProv,toDim,field,toValue,toStand);takeRetired();}
  else discard(from,fromProv,fromDim,field,fromValue,fromStand);
 }
 if(sets.length){
  // the value change first: the invalidation trigger removes the survivor's stale non-owner row, then the retired row is written explicitly
  out.items.splice(0,0,['UPDATE film_metadata SET '+sets.join(',')+' WHERE film_id=?',[...params,to]]);
 }
 out.post.push(['DELETE FROM film_metadata_field WHERE film_id=?',[from]]);
 releaseDone();
 return out;
}
